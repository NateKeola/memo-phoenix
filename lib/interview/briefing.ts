import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isReconfirmCandidate, reconfirmPriority, RECONFIRM } from '@/lib/freshness/decay'

export type BriefItem = { kind: string; label: string; detail?: string }
export type Brief = {
  items: BriefItem[]
  text: string
  itemCount: number
  // kept for record compatibility; false now that resurfacing is real selection,
  // not a stub. reconfirmCount is how many "is this still true?" checks were folded in.
  resurfacingStub: boolean
  reconfirmCount: number
}

// Deterministic briefing: the LLM is a pipeline stage, so WHAT to surface is
// chosen by code here, not by the model. Reads the user's canonical graph via the
// RLS-scoped client (canonical is SELECT-only for the signed-in user). No LLM
// call: the brief text is assembled in code.
export async function composeBrief(supabase: SupabaseClient, now: number = Date.now()): Promise<Brief> {
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

  // --- reconfirmation layer (spec §3): real decay + salience selection ---
  // Aging, high-value decaying nodes are folded into the interview as light
  // "is this still true?" checks; the user's answer renews or supersedes them on
  // the next mine. reconfirm_candidates is the view of decaying current rows;
  // the decay + salience thresholds are applied here in code, not in the view.
  const alreadyShown = new Set(items.map((i) => i.label.toLowerCase()))
  const reconfirm = await selectReconfirmCandidates(supabase, now, alreadyShown)
  for (const r of reconfirm) items.push(r)

  return {
    items,
    text: renderBriefText(items),
    itemCount: items.length,
    resurfacingStub: false,
    reconfirmCount: reconfirm.length,
  }
}

// Real reconfirm selection: decaying current nodes that have aged below the
// confidence threshold and are salient enough to be worth asking about, most
// faded first, deduped against what the recency layer already surfaced.
type ReconfirmRow = {
  table_name: string
  id: string
  label: string | null
  confidence: number | null
  salience: number | null
  last_confirmed_at: string | null
}

const RECONFIRM_TABLES = [
  'canonical_people',
  'canonical_places_orgs',
  'canonical_projects',
  'canonical_events',
  'canonical_facts',
  'canonical_relationships',
  'canonical_commitments',
  'insights',
]

// Read the decaying current rows. Prefers the reconfirm_candidates view (one query,
// the spec's designated basis); if the view is not exposed to the signed-in role
// it falls back to querying the canonical tables directly (the same access path the
// recency layer uses), so reconfirm can never silently return empty on a grant gap.
async function readReconfirmRows(supabase: SupabaseClient): Promise<ReconfirmRow[]> {
  const { data, error } = await supabase
    .from('reconfirm_candidates')
    .select('table_name, id, label, confidence, salience, last_confirmed_at')
  if (!error && Array.isArray(data)) return data as ReconfirmRow[]
  const out: ReconfirmRow[] = []
  for (const table of RECONFIRM_TABLES) {
    const { data: rows } = await supabase
      .from(table)
      .select('id, label, confidence, salience, last_confirmed_at')
      .is('valid_to', null)
      .eq('temporality', 'decaying')
    for (const r of (rows ?? []) as Array<Omit<ReconfirmRow, 'table_name'>>) out.push({ ...r, table_name: table })
  }
  return out
}

async function selectReconfirmCandidates(
  supabase: SupabaseClient,
  now: number,
  exclude: Set<string>
): Promise<BriefItem[]> {
  const rows = await readReconfirmRows(supabase)
  const inputOf = (r: ReconfirmRow) => ({
    temporality: 'decaying',
    confidence: r.confidence,
    salience: r.salience,
    lastConfirmedAt: r.last_confirmed_at,
  })
  return rows
    .filter((r) => {
      const label = str(r.label)
      if (!label || exclude.has(label.toLowerCase())) return false
      return isReconfirmCandidate(inputOf(r), now)
    })
    .sort((a, b) => reconfirmPriority(inputOf(b), now) - reconfirmPriority(inputOf(a), now))
    .slice(0, RECONFIRM.maxItems)
    .map((r) => ({ kind: 'reconfirm', label: str(r.label) as string, detail: humanType(r.table_name) }))
}

function humanType(table: string): string {
  return (
    {
      canonical_people: 'someone you know',
      canonical_places_orgs: 'a place or group',
      canonical_projects: 'a project',
      canonical_events: 'an event',
      canonical_facts: 'something about you',
      canonical_relationships: 'a relationship',
      canonical_commitments: 'a follow-up',
      insights: 'a pattern',
    }[table] ?? 'something'
  )
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function renderBriefText(items: BriefItem[]): string {
  if (items.length === 0) return '' // thin graph: empty brief reads as open mode

  const recency = items.filter((i) => i.kind !== 'reconfirm')
  const reconfirm = items.filter((i) => i.kind === 'reconfirm')

  const lines: string[] = []
  lines.push('Here is what you already know about them, to steer toward gently. Pick one or two; never recite this list.')
  if (recency.length > 0) {
    lines.push('')
    lines.push('Recent threads and follow-ups:')
    for (const i of recency) lines.push(`- ${labelFor(i)}${i.detail ? ` (${i.detail})` : ''}`)
  }
  if (reconfirm.length > 0) {
    lines.push('')
    lines.push(
      'You have not mentioned these in a while; gently check whether they are still true, the way a caring friend would, and let the answer update you. Do not interrogate; weave it in:'
    )
    for (const i of reconfirm) lines.push(`- ${i.label}${i.detail ? ` (${i.detail})` : ''}`)
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

// ---- targeted briefs (capture-with-target interviews) -----------------------
// Reuse the briefing-injection mechanism (fill DAILY_BRIEF), but seed it at a
// specific person or a chat topic instead of the daily graph scan. The resulting
// interview aims the conversation at building context on the target.

function strv(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

// A brief that aims the conversation at deepening context on one person.
export async function composePersonBrief(supabase: SupabaseClient, userId: string, personId: string): Promise<Brief> {
  const { data: person } = await supabase
    .from('canonical_people')
    .select('label, data, summary')
    .eq('user_id', userId)
    .eq('id', personId)
    .is('valid_to', null)
    .maybeSingle()
  if (!person) return { items: [], text: '', itemCount: 0, resurfacingStub: false, reconfirmCount: 0 }
  const p = person as { label: string | null; data: Record<string, unknown> | null; summary: string | null }
  const d = p.data ?? {}
  const name =
    `${strv(d.first_name) ?? ''} ${strv(d.last_name) ?? ''}`.trim() || strv(p.label) || 'this person'

  const { data: rels } = await supabase
    .from('canonical_relationships')
    .select('summary, data')
    .eq('user_id', userId)
    .is('valid_to', null)
  const related = (rels ?? [])
    .filter((r) => {
      const rd = (r as { data: Record<string, unknown> | null }).data ?? {}
      return rd.source_id === personId || rd.target_id === personId
    })
    .map((r) => strv((r as { summary: string | null }).summary))
    .filter(Boolean)
    .slice(0, 4)

  const lines: string[] = []
  lines.push(`This conversation is to deepen what you know about ${name}. Help the user add context, memories, and detail about them. Ask warm, specific questions and follow where they lead.`)
  const known: string[] = []
  if (strv(p.summary)) known.push(strv(p.summary) as string)
  if (strv(d.relationship)) known.push(`Relationship: ${strv(d.relationship)}`)
  if (related.length > 0) known.push(...related.map((s) => `Connected: ${s}`))
  if (known.length > 0) {
    lines.push('')
    lines.push(`What you already know about ${name} (steer toward gently, never recite):`)
    for (const k of known.slice(0, 6)) lines.push(`- ${k}`)
  }
  const text = lines.join('\n')
  return {
    items: [{ kind: 'target_person', label: name }],
    text,
    itemCount: 1,
    resurfacingStub: false,
    reconfirmCount: 0,
  }
}

// A brief that aims the conversation at going deeper on a chat topic.
export function composeTopicBrief(seed: string): Brief {
  const topic = (seed ?? '').trim().slice(0, 500)
  if (!topic) return { items: [], text: '', itemCount: 0, resurfacingStub: false, reconfirmCount: 0 }
  const text = [
    `This conversation is to go deeper on something the user was just exploring: ${topic}`,
    '',
    'Help them think it through and gather more context on the people and things involved. Ask specific, useful questions and let them talk.',
  ].join('\n')
  return { items: [{ kind: 'target_topic', label: topic }], text, itemCount: 1, resurfacingStub: false, reconfirmCount: 0 }
}
