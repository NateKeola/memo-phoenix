// Read helpers for the contact sheet (spec §11). Pure query logic parameterized
// by an RLS-scoped client (same shape as lib/chat/retrieval.ts), so every read is
// the signed-in user's rows only. Reuses the chat surface's neighbors + provenance
// resolution rather than duplicating it.
import type { SupabaseClient } from '@supabase/supabase-js'
import { neighborsOf, resolveProvenance, type ProvenanceHit, type RetrievalDeps } from '@/lib/chat/retrieval'
import { firstLast, personDisplay, splitName } from '@/lib/names'

export type { RetrievalDeps } from '@/lib/chat/retrieval'

function dataOf(row: { data?: Record<string, unknown> | null }): Record<string, unknown> {
  return row.data ?? {}
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []
}
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

// Pending-rename display overlay (the Karalea fix). A confirmed rename flows
// through the corrections table and is applied by the miner on its next run; until
// then the displayed name would lag. This reads the pending rename corrections and
// maps the SPECIFIC PERSON ID they target to the corrected name, so a rename
// reaches the contact sheet immediately. It never edits canonical. Keying on the
// person id (not the label) means it cannot re-fire onto a different later person
// who reuses the old name. A later rename of the same id wins (corrections are read
// in created_at order). Merges are not shown optimistically: they collapse rows on
// the mine, and faking that pre-mine would show two rows with the same name.
//
// CLEARING (applyPending): the overlay is "pending" only while the canonical label
// still differs from the target. It clears in EITHER of the two ways a rename can
// land: (a) the miner superseded the row onto a new survivor id, so the old id is no
// longer current (not iterated at all); or (b) the stable-identity resolver kept the
// row's id and relabeled it IN PLACE, so the current row's label now equals the
// target. The original code only handled (a) ("self-consumes once the person's id
// changes"), so an in-place rename (Morgan -> Morgan Alexander, Nate -> Nate
// Tennant) stayed "pending" forever even though it had applied. Checking the label
// covers both.
export async function pendingRenames(deps: RetrievalDeps): Promise<Map<string, string>> {
  const { data } = await deps.supabase
    .from('corrections')
    .select('payload, created_at')
    .eq('user_id', deps.userId)
    .eq('kind', 'rename_person')
    .order('created_at', { ascending: true })
  const out = new Map<string, string>()
  for (const c of (data ?? []) as Array<{ payload: Record<string, unknown> | null }>) {
    const p = c.payload ?? {}
    const personId = str(p.person_id)
    const to = str(p.to_label) || str(p.to)
    if (personId && to) out.set(personId, to)
  }
  return out
}

function applyPending(
  id: string,
  label: string | null,
  renames: Map<string, string>
): { name: string | null; pending: boolean; landed: boolean } {
  const to = renames.get(id)
  if (!to) return { name: label, pending: false, landed: false }
  // The rename has landed once the current row's label matches the target (the miner
  // relabeled it in place; its id did not change). Only pending while the label still
  // differs. `landed` tells the display to derive first/last from the target label,
  // not from data.first_name (which a drifted incremental fold can leave stale even
  // when the label matches).
  if (label && norm(label) === norm(to)) return { name: label, pending: false, landed: true }
  return { name: to, pending: true, landed: false }
}

export type PersonListItem = {
  id: string
  name: string | null
  first: string
  last: string
  pendingRename: boolean
  relationship: string | null
  role: string | null
  closeness: string | null
  work_or_personal: string | null
  aliases: string[]
  salience: number
}

type PersonRow = {
  id: string
  label: string | null
  data: Record<string, unknown> | null
  salience: number | null
}

function toListItem(r: PersonRow, renames: Map<string, string>): PersonListItem {
  const d = dataOf(r)
  const pend = applyPending(r.id, r.label, renames)
  // first/last from the corrected name when a rename is pending OR has just landed
  // (so the display tracks the rename, not a possibly-stale data.first_name), else
  // from the miner-persisted first/last (falling back to splitting the label).
  const fl = pend.pending || pend.landed ? splitName(pend.name) : firstLast(r.label, d)
  return {
    id: r.id,
    name: personDisplay(fl.first, fl.last) || pend.name,
    first: fl.first,
    last: fl.last,
    pendingRename: pend.pending,
    relationship: str(d.relationship),
    role: str(d.role),
    closeness: str(d.closeness),
    work_or_personal: str(d.work_or_personal),
    aliases: strArr(d.aliases),
    salience: r.salience ?? 0,
  }
}

// All current people, salience-ordered then alphabetical, with the pending-rename
// overlay applied to the displayed name.
export async function listPeople(deps: RetrievalDeps): Promise<PersonListItem[]> {
  const [{ data, error }, renames] = await Promise.all([
    deps.supabase
      .from('canonical_people')
      .select('id, label, data, salience')
      .eq('user_id', deps.userId)
      .is('valid_to', null)
      .order('salience', { ascending: false })
      .order('label', { ascending: true }),
    pendingRenames(deps),
  ])
  if (error) throw new Error(`[people] list: ${error.message}`)
  return ((data ?? []) as PersonRow[]).map((r) => toListItem(r, renames))
}

export type PersonDetail = {
  id: string
  name: string | null
  first: string
  last: string
  pendingRename: boolean
  summary: string | null
  data: Record<string, unknown>
  source_claim_ids: string[]
  provenance: ProvenanceHit[]
  relationships: Awaited<ReturnType<typeof neighborsOf>>['edges']
  commitments: Array<{ id: string; label: string | null; due: unknown; status: unknown }>
}

async function commitmentsForPerson(
  deps: RetrievalDeps,
  personId: string
): Promise<PersonDetail['commitments']> {
  const { data, error } = await deps.supabase
    .from('canonical_commitments')
    .select('id, label, data')
    .eq('user_id', deps.userId)
    .is('valid_to', null)
  if (error) throw new Error(`[people] commitments: ${error.message}`)
  return ((data ?? []) as Array<{ id: string; label: string | null; data: Record<string, unknown> | null }>)
    .filter((r) => str(dataOf(r).person_id) === personId)
    .map((r) => ({ id: r.id, label: r.label, due: dataOf(r).due ?? null, status: dataOf(r).status ?? 'open' }))
}

// One person plus what is tied to them: relationships (the graph edges), the
// commitments that name them, and provenance for where they first came from.
export async function getPersonDetail(deps: RetrievalDeps, id: string): Promise<PersonDetail | null> {
  const { data, error } = await deps.supabase
    .from('canonical_people')
    .select('id, label, data, summary, source_claim_ids')
    .eq('user_id', deps.userId)
    .eq('id', id)
    .is('valid_to', null)
    .maybeSingle()
  if (error) throw new Error(`[people] detail: ${error.message}`)
  if (!data) return null
  const row = data as { id: string; label: string | null; data: Record<string, unknown> | null; summary: string | null; source_claim_ids: string[] | null }
  const claimIds = row.source_claim_ids ?? []
  const [neighbors, provenance, commitments, renames] = await Promise.all([
    neighborsOf(deps, id),
    resolveProvenance(deps, claimIds),
    commitmentsForPerson(deps, id),
    pendingRenames(deps),
  ])
  const pend = applyPending(row.id, row.label, renames)
  const fl = pend.pending || pend.landed ? splitName(pend.name) : firstLast(row.label, dataOf(row))
  return {
    id: row.id,
    name: personDisplay(fl.first, fl.last) || pend.name,
    first: fl.first,
    last: fl.last,
    pendingRename: pend.pending,
    summary: row.summary,
    data: dataOf(row),
    source_claim_ids: claimIds,
    provenance,
    relationships: neighbors.edges,
    commitments,
  }
}

// Likely-duplicate candidates for a person: other people whose name or aliases
// overlap (shared first name, containment, or alias match). Ranked, capped. This
// only surfaces suggestions; a merge happens on explicit user confirmation.
export function scoreSimilarity(aForms: string[], bForms: string[]): number {
  const a = aForms.map(norm).filter(Boolean)
  const b = bForms.map(norm).filter(Boolean)
  if (a.length === 0 || b.length === 0) return 0
  let best = 0
  for (const x of a) {
    for (const y of b) {
      if (x === y) best = Math.max(best, 100)
      else if (x.includes(y) || y.includes(x)) best = Math.max(best, 70)
      else {
        const xf = x.split(' ')[0]
        const yf = y.split(' ')[0]
        if (xf && xf === yf) best = Math.max(best, 40)
      }
    }
  }
  return best
}

export async function duplicateCandidates(
  deps: RetrievalDeps,
  person: { id: string; name: string | null; aliases: string[] },
  // Optionally pass an already-fetched people list to avoid a redundant query (the
  // person-detail page needs the full list for its "merge into" picker anyway, so it
  // fetches once and reuses it here instead of listPeople running twice).
  people?: PersonListItem[]
): Promise<PersonListItem[]> {
  const all = people ?? (await listPeople(deps))
  const targetForms = [person.name ?? '', ...person.aliases]
  return all
    .filter((p) => p.id !== person.id)
    .map((p) => ({ p, score: scoreSimilarity(targetForms, [p.name ?? '', ...p.aliases]) }))
    .filter((x) => x.score >= 40)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.p)
}
