// Relationship nudges + plain-language phrasing for the companion. The heuristic
// here is intentionally SIMPLE and transparent: it surfaces close people who have
// not come up much. The real decay-and-salience scoring is the freshness loop (a
// later PR); this is a documented placeholder, not that scoring.
import type { RetrievalDeps } from '@/lib/chat/retrieval'

const RAW_TABLES = [
  'raw_people',
  'raw_places_orgs',
  'raw_projects',
  'raw_events',
  'raw_facts',
  'raw_relationships',
  'raw_commitments',
  'raw_collection_mentions',
] as const

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}
function fmtDate(iso: string | null): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const dt = new Date(t)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`
}

// Closeness weight from the person's relationship/closeness fields. The person's
// NAME is deliberately NOT matched (a name like "Mark" or "Rose" is not a
// relationship signal). Only people who clearly matter (weight >= 2) are nudged
// about; acquaintances and pure work ties are not.
export function closenessWeight(p: { label?: string | null; closeness: string | null; relationship: string | null }): number {
  const hay = `${p.closeness ?? ''} ${p.relationship ?? ''}`.toLowerCase()
  const family = /\b(mom|mother|dad|father|brother|sister|son|daughter|aunt|uncle|grandma|grandpa|grandmother|grandfather|wife|husband|fiance|fiancee|spouse|girlfriend|boyfriend|life partner|cousin|nephew|niece|family|mother figure)\b/
  const bestFriend = /\bbest (friend|buddy|bud)\b|\bclosest\b/
  // a work tie (business partner/associate) is not a personal nudge unless the
  // person is also clearly close family or a best friend.
  if (/\bbusiness\b/.test(hay) && !bestFriend.test(hay) && !family.test(hay)) return 0
  if (bestFriend.test(hay)) return 3
  if (family.test(hay)) return 3
  if (/\bclose\b/.test(hay)) return 2
  if (/\bfriend\b/.test(hay)) return 1
  return 0
}

export type RelationshipNudge = {
  personId: string
  name: string | null
  descriptor: string
  suggestion: string
  lastMentioned: string | null
  mentionCount: number
  provenance: string | null
}

type PersonRow = { id: string; label: string | null; data: Record<string, unknown> | null; source_claim_ids: string[] | null }

// Map a set of raw claim ids to the capture ids and dates they came from, in one
// batched pass over the raw tables plus captures.
async function claimDates(deps: RetrievalDeps, claimIds: string[]): Promise<Map<string, { captureId: string; createdAt: string }>> {
  const ids = [...new Set(claimIds.filter(Boolean))]
  const out = new Map<string, { captureId: string; createdAt: string }>()
  if (ids.length === 0) return out
  const claimToCapture = new Map<string, string>()
  await Promise.all(
    RAW_TABLES.map(async (t) => {
      const { data } = await deps.supabase.from(t).select('id, capture_id').eq('user_id', deps.userId).in('id', ids)
      for (const r of (data ?? []) as Array<{ id: string; capture_id: string }>) claimToCapture.set(r.id, r.capture_id)
    })
  )
  const captureIds = [...new Set([...claimToCapture.values()])]
  const capDate = new Map<string, string>()
  if (captureIds.length > 0) {
    const { data } = await deps.supabase.from('captures').select('id, created_at').eq('user_id', deps.userId).in('id', captureIds)
    for (const c of (data ?? []) as Array<{ id: string; created_at: string }>) capDate.set(c.id, c.created_at)
  }
  for (const [claim, capId] of claimToCapture) {
    const createdAt = capDate.get(capId)
    if (createdAt) out.set(claim, { captureId: capId, createdAt })
  }
  return out
}

function describe(p: { relationship: string | null; closeness: string | null }): string {
  const rel = (p.relationship ?? '').trim()
  const close = (p.closeness ?? '').trim()
  const pick = rel && rel.toLowerCase() !== 'acquaintance' ? rel : close
  if (!pick) return 'someone close to you'
  // do not prefix "your" when the descriptor is already possessive ("Kyle's wife")
  if (/'s\b|\byour\b/i.test(pick)) return pick
  return `your ${pick}`
}

// Close people the user has not engaged with much, ranked. Simple and transparent:
// closeness weight first, then least-recently-mentioned, then fewest mentions.
export async function relationshipNudges(deps: RetrievalDeps, nowMs: number, limit = 5): Promise<RelationshipNudge[]> {
  const { data, error } = await deps.supabase
    .from('canonical_people')
    .select('id, label, data, source_claim_ids')
    .eq('user_id', deps.userId)
    .is('valid_to', null)
  if (error) throw new Error(`[companion] people for nudges: ${error.message}`)
  const people = (data ?? []) as PersonRow[]

  const allClaims = people.flatMap((p) => p.source_claim_ids ?? [])
  const dates = await claimDates(deps, allClaims)

  type Scored = {
    p: PersonRow
    weight: number
    lastMs: number
    lastIso: string | null
    captures: Set<string>
  }
  const scored: Scored[] = []
  for (const p of people) {
    const d = p.data ?? {}
    const weight = closenessWeight({ label: p.label, closeness: str(d.closeness), relationship: str(d.relationship) })
    if (weight < 2) continue // only nudge about people who clearly matter
    const captures = new Set<string>()
    let lastMs = 0
    let lastIso: string | null = null
    for (const claim of p.source_claim_ids ?? []) {
      const hit = dates.get(claim)
      if (!hit) continue
      captures.add(hit.captureId)
      const t = Date.parse(hit.createdAt)
      if (Number.isFinite(t) && t > lastMs) {
        lastMs = t
        lastIso = hit.createdAt
      }
    }
    scored.push({ p, weight, lastMs, lastIso, captures })
  }

  scored.sort((a, b) => b.weight - a.weight || a.lastMs - b.lastMs || a.captures.size - b.captures.size)

  return scored.slice(0, limit).map((s) => {
    const d = s.p.data ?? {}
    const descriptor = describe({ relationship: str(d.relationship), closeness: str(d.closeness) })
    const count = s.captures.size
    const recencyPhrase =
      count === 0
        ? 'they have not come up recently'
        : count === 1
          ? 'they have only come up once'
          : 'they have not come up much lately'
    const last = fmtDate(s.lastIso)
    return {
      personId: s.p.id,
      name: s.p.label,
      descriptor,
      suggestion: `${s.p.label ?? 'Someone close'} is ${descriptor}, and ${recencyPhrase}. Worth reaching out?`,
      lastMentioned: last,
      mentionCount: count,
      provenance: last ? `last mentioned ${last}` : null,
    }
  })
}

// Plain-language phrasing for a commitment follow-up (a suggestion to act, not a
// database readout). The label often already names the person and the action.
export function phraseCommitment(
  label: string | null,
  personName: string | null,
  due: string | null
): { headline: string; suggestion: string } {
  const raw = (label ?? '').trim()
  if (!raw) return { headline: 'A follow-up', suggestion: 'You have a loose end worth tending.' }
  // lowercase the leading verb for the sentence, but leave an acronym intact (USC,
  // DSD) so "USC reunion" does not become "uSC reunion".
  const verb = /^[A-Z]{2,}/.test(raw) ? raw : raw.charAt(0).toLowerCase() + raw.slice(1)
  let suggestion = `You said you'd ${verb}`
  if (due) suggestion += `, ${due}`
  suggestion += '.'
  const firstName = personName ? personName.split(' ')[0].toLowerCase() : ''
  if (personName && firstName && !raw.toLowerCase().includes(firstName)) {
    suggestion += ` A nudge to follow up with ${personName}.`
  }
  return { headline: raw, suggestion }
}
