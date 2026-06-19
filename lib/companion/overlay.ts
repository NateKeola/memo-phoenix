// The commitment-state overlay (done / snooze / dismiss), kept label-drift
// resilient. companion_state is keyed on the deterministic commitment id (uuidv5
// over the normalized label), so a label drift on a later mine changes the id and
// would orphan the overlay (a done item reappears as not-done). We store a stable
// signature at write time (label + linked person) and, when an exact id match
// fails, re-associate the overlay row to a re-resolved commitment by person
// agreement plus a fuzzy label match. Local fix on the overlay only; the
// root-cause identity hardening across the miner is a separate dedicated PR.
import type { SupabaseClient } from '@supabase/supabase-js'

export type OverlayRow = {
  commitment_id: string
  state: string
  snooze_until: string | null
  match_label: string | null
  match_person_id: string | null
}

export type CommitmentRef = { id: string; label: string | null; personId: string | null }

const STOP = new Set([
  'the', 'a', 'an', 'to', 'with', 'for', 'of', 'and', 'my', 'i', 'will', 'would',
  'should', 'get', 'go', 'do', 'have', 'has', 'need', 'want', 'on', 'at', 'in',
])

function normTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP.has(t))
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

// When both the commitment and the stored signature carry the SAME person, that
// agreement is strong corroboration, so a moderate label overlap is enough. With
// no person to corroborate (person_id is optional on a mined commitment), a
// label-only re-association needs MUCH stronger agreement, otherwise two short
// formulaic labels ("buy birthday gift" vs "buy holiday gift", Jaccard 0.5) could
// carry one item's done/dismissed state onto a genuinely different follow-up and
// silently hide it.
const FUZZY_WITH_PERSON = 0.5
const FUZZY_LABEL_ONLY = 0.8

// Map current commitments to their overlay rows. Exact id first; then re-match a
// drifted commitment to a free overlay row by person agreement plus a fuzzy label
// match on the stored signature, with the threshold gated on whether a person
// corroborates the match.
export function matchOverlay(commitments: CommitmentRef[], overlay: OverlayRow[]): Map<string, OverlayRow> {
  const byId = new Map(overlay.map((o) => [o.commitment_id, o]))
  const result = new Map<string, OverlayRow>()
  const used = new Set<string>()

  for (const c of commitments) {
    const o = byId.get(c.id)
    if (o) {
      result.set(c.id, o)
      used.add(o.commitment_id)
    }
  }

  // overlay rows that did not exact-match any current commitment id are candidates
  // for re-association (their commitment likely re-resolved under a new id).
  const currentIds = new Set(commitments.map((c) => c.id))
  const free = overlay.filter((o) => !used.has(o.commitment_id) && !currentIds.has(o.commitment_id) && o.match_label)

  for (const c of commitments) {
    if (result.has(c.id)) continue
    const cTokens = normTokens(c.label ?? '')
    let best: { o: OverlayRow; score: number } | null = null
    for (const o of free) {
      if (used.has(o.commitment_id)) continue
      const bothHavePerson = Boolean(c.personId && o.match_person_id)
      // a disagreeing person is a hard no; a matching person relaxes the bar
      if (bothHavePerson && c.personId !== o.match_person_id) continue
      const threshold = bothHavePerson ? FUZZY_WITH_PERSON : FUZZY_LABEL_ONLY
      const score = jaccard(cTokens, normTokens(o.match_label ?? ''))
      if (score >= threshold && (!best || score > best.score)) best = { o, score }
    }
    if (best) {
      result.set(c.id, best.o)
      used.add(best.o.commitment_id)
    }
  }
  return result
}

// Read the overlay with select('*') so the new match columns are optional (they
// land with migration 0011, applied on merge); degrade to no overlay on error.
export async function readOverlay(supabase: SupabaseClient, userId: string): Promise<OverlayRow[]> {
  const { data, error } = await supabase.from('companion_state').select('*').eq('user_id', userId)
  if (error) {
    console.error('[companion] readOverlay (degrading to no overlay):', error.message)
    return []
  }
  return (data ?? []).map((r) => {
    const row = r as Record<string, unknown>
    return {
      commitment_id: String(row.commitment_id),
      state: String(row.state ?? 'open'),
      snooze_until: (row.snooze_until as string | null) ?? null,
      match_label: (row.match_label as string | null) ?? null,
      match_person_id: (row.match_person_id as string | null) ?? null,
    }
  })
}
