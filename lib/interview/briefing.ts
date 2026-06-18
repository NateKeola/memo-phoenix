import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

export type BriefItem = { kind: string; label: string; detail?: string }
export type Brief = { items: BriefItem[]; text: string; itemCount: number; resurfacingStub: boolean }

// Deterministic briefing: the LLM is a pipeline stage, so WHAT to surface is
// chosen by code here, not by the model. Reads the user's canonical graph via the
// RLS-scoped client (canonical is SELECT-only for the signed-in user). No LLM
// call: the brief text is assembled in code.
export async function composeBrief(supabase: SupabaseClient): Promise<Brief> {
  const items: BriefItem[] = []

  // --- recency layer (real) ---

  // open commitments and follow-ups
  const { data: commitments } = await supabase
    .from('canonical_commitments')
    .select('label, summary, data, created_at')
    .is('valid_to', null)
    .order('created_at', { ascending: false })
    .limit(20)
  const openCommitments = (commitments ?? [])
    .filter((c) => String((c.data as Record<string, unknown>)?.status ?? 'open').toLowerCase() !== 'done')
    .slice(0, 3)
  for (const c of openCommitments) {
    const data = (c.data ?? {}) as Record<string, unknown>
    const detail = [data.due ? `due ${data.due}` : '', data.work_or_personal].filter(Boolean).join(', ')
    items.push({ kind: 'open_commitment', label: str(c.label) ?? 'a follow-up', detail: detail || str(c.summary) })
  }

  // recently added or changed people, projects, events
  const { data: people } = await supabase
    .from('canonical_people')
    .select('label, summary, created_at')
    .is('valid_to', null)
    .order('created_at', { ascending: false })
    .limit(3)
  for (const p of people ?? []) items.push({ kind: 'recent_person', label: str(p.label) ?? 'someone', detail: str(p.summary) })

  const { data: projects } = await supabase
    .from('canonical_projects')
    .select('label, summary, data, created_at')
    .is('valid_to', null)
    .order('created_at', { ascending: false })
    .limit(3)
  for (const pr of projects ?? []) {
    const status = str((pr.data as Record<string, unknown>)?.status)
    items.push({ kind: 'recent_project', label: str(pr.label) ?? 'a project', detail: status ?? str(pr.summary) })
  }

  const { data: events } = await supabase
    .from('canonical_events')
    .select('label, data, created_at')
    .is('valid_to', null)
    .order('created_at', { ascending: false })
    .limit(2)
  for (const e of events ?? []) items.push({ kind: 'recent_event', label: str(e.label) ?? 'an event', detail: str((e.data as Record<string, unknown>)?.date) })

  // --- deep-resurfacing layer (STUB) ---
  // Placeholder heuristic only: the oldest-seen people, ranked by salience. The
  // real decay-and-salience scoring is PR8; this is just enough to demonstrate
  // "you have not mentioned Z in a while."
  const recentPeopleLabels = new Set(items.filter((i) => i.kind === 'recent_person').map((i) => i.label))
  const { data: older } = await supabase
    .from('canonical_people')
    .select('label, summary, salience, created_at')
    .is('valid_to', null)
    .order('created_at', { ascending: true })
    .limit(12)
  const resurfaced = (older ?? [])
    .filter((p) => !recentPeopleLabels.has(str(p.label) ?? ''))
    .sort((a, b) => (Number(b.salience) || 0) - (Number(a.salience) || 0))
    .slice(0, 2)
  for (const p of resurfaced) items.push({ kind: 'resurface_stub', label: str(p.label) ?? 'someone', detail: str(p.summary) })

  return { items, text: renderBriefText(items), itemCount: items.length, resurfacingStub: true }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function renderBriefText(items: BriefItem[]): string {
  if (items.length === 0) return '' // thin graph: empty brief reads as open mode

  const recency = items.filter((i) => i.kind !== 'resurface_stub')
  const resurface = items.filter((i) => i.kind === 'resurface_stub')

  const lines: string[] = []
  lines.push('Here is what you already know about them, to steer toward gently. Pick one or two; never recite this list.')
  if (recency.length > 0) {
    lines.push('')
    lines.push('Recent threads and follow-ups:')
    for (const i of recency) lines.push(`- ${labelFor(i)}${i.detail ? ` (${i.detail})` : ''}`)
  }
  if (resurface.length > 0) {
    lines.push('')
    lines.push('Worth gently resurfacing, you have not talked about them in a while (placeholder selection; real scoring comes later):')
    for (const i of resurface) lines.push(`- ${i.label}${i.detail ? ` (${i.detail})` : ''}`)
  }
  return lines.join('\n')
}

function labelFor(i: BriefItem): string {
  switch (i.kind) {
    case 'open_commitment':
      return `Open follow-up: ${i.label}`
    case 'recent_person':
      return `Came up recently: ${i.label}`
    case 'recent_project':
      return `Lately working on: ${i.label}`
    case 'recent_event':
      return `Recent: ${i.label}`
    default:
      return i.label
  }
}
