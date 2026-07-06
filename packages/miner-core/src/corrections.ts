// People identity corrections (spec §4.2 corrections, §11 contact sheet).
//
// Corrections are append-only ground-truth inputs the user issues from the contact
// sheet. The miner reads them on every recompute and applies them during canonical
// derivation, so a fix survives the nightly full recompute (editing canonical
// directly would be wiped). Two kinds touch people identity:
//   rename_person  payload { from_label, to_label }   relabel a person
//   merge_people   payload { from_label, into_label }  collapse two rows into one
//
// Both are the SAME mechanism: rewrite a source label to a target label BEFORE the
// deterministic id is computed. Identity is uuidv5 over the normalized label, so a
// label rewrite reroutes every mention of the old surface form onto the target's
// id. The existing same-id collapse in the people pass then unions provenance and
// aliases. The stale pre-correction row (the "loser") is superseded by the miner.
import { admin } from './supabase'
import { canonicalJson, canonicalPersonId, normalizeLabel, sha256, splitName } from './identity'

const PEOPLE_TABLE = 'canonical_people'
const PEOPLE_KINDS = ['rename_person', 'merge_people']

// Relationship edges are keyed on their endpoints (id = hash of source|target|
// relation), so a merge's re-resolution emits a NEW survivor-referencing edge
// (a new id, inserted) and the stale loser edge must be RETIRED.
const RETIRE_TABLES: Array<{ table: string; refsOf: (data: Record<string, unknown>) => string[] }> = [
  { table: 'canonical_relationships', refsOf: (d) => [asStr(d.source_id), asStr(d.target_id)].filter(Boolean) },
]

// These rows are keyed on their OWN label (not the person), so re-resolution
// reuses the SAME id and writeCanonical skips the data-only person-ref change
// (its change-signature excludes data). We REPOINT the embedded person references
// in place instead, which is lossless (no row is dropped) and idempotent.
const REPOINT_SPECS: Array<{ table: string; scalarFields?: string[]; arrayFields?: string[] }> = [
  { table: 'canonical_commitments', scalarFields: ['person_id'] },
  { table: 'canonical_projects', arrayFields: ['related_ids'] },
  { table: 'canonical_events', arrayFields: ['related_ids'] },
  { table: 'insights', arrayFields: ['affected_entity_ids'] },
]

function uniqArray(v: unknown[]): unknown[] {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const x of v) {
    const key = typeof x === 'string' ? x : JSON.stringify(x)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(x)
  }
  return out
}

export type CorrectionRow = { id: string; kind: string; payload: Record<string, unknown>; created_at: string }

export type PeopleRewrite = {
  // normalized source label -> final survivor label (chained to a fixpoint)
  labelToFinal: Map<string, string>
  // loser canonical id -> the FINAL survivor LABEL. The survivor's actual row id is
  // resolved AFTER the people pass by looking the label up among the current rows
  // (resolveSurvivorIds), never by hashing the label: with the stable-identity
  // resolver active a fresh survivor label gets a random id, and the old
  // hash-the-label shortcut is exactly what produced the live dangling
  // superseded_by pointer (the Morgan case: the loser was retired onto a survivor
  // id that never materialized).
  loserToSurvivorLabel: Map<string, string>
  // ONLY the rename_person in-place targets: targeted-row-id -> final label. Used by
  // applyRenameLabels to force a pure relabel that writeCanonical would skip. It must
  // NOT include merge losers: a merge's from-row is superseded onto a DIFFERENT into
  // row (or, when the into row does not materialize this run, deliberately left
  // current by resolveSurvivorIds); relabeling it in place would corrupt a distinct
  // person and defeat that guard. A rename whose target resolves to a distinct
  // existing row is still safe: that row is superseded, so applyRenameLabels'
  // valid_to filter skips it.
  renameTargets: Map<string, string>
  // fingerprint of the applied corrections, '' when there are none (busts the
  // people pass memo when a new correction is issued)
  fingerprint: string
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export async function readPeopleCorrections(userId: string): Promise<CorrectionRow[]> {
  const { data, error } = await admin()
    .from('corrections')
    .select('id, kind, payload, created_at')
    .eq('user_id', userId)
    .in('kind', PEOPLE_KINDS)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`[miner] read corrections: ${error.message}`)
  return (data ?? []).map((r) => {
    const row = r as { id: string; kind: string; payload: Record<string, unknown> | null; created_at: string }
    return { id: row.id, kind: row.kind, payload: row.payload ?? {}, created_at: row.created_at }
  })
}

function fromTo(c: CorrectionRow): { from: string; to: string; fromId: string } | null {
  const p = c.payload
  const from = asStr(p.from_label) || asStr(p.from)
  const to = c.kind === 'merge_people' ? asStr(p.into_label) || asStr(p.into) : asStr(p.to_label) || asStr(p.to)
  if (!from || !to) return null
  if (normalizeLabel(from) === normalizeLabel(to)) return null // no-op
  // The id of the row the user actually targeted (the UI stamps person_id on a
  // rename and from_id on a merge). Preferred over recomputing an id from the
  // label, which is only valid for label-hash ids and silently misses a row whose
  // id was minted by the resolver.
  const fromId = c.kind === 'merge_people' ? asStr(p.from_id) : asStr(p.person_id)
  return { from, to, fromId }
}

// Build the people rewrite from corrections applied in created_at order. Rename
// and merge contribute the same kind of edge (normalized from-label -> to-label).
// Edges are chained to a fixpoint so a sequence A->B, B->C collapses A and B onto C.
export function buildPeopleRewrite(userId: string, corrections: CorrectionRow[]): PeopleRewrite {
  const edge = new Map<string, string>() // normalized from -> to (display form)
  const fromIds = new Map<string, string>() // normalized from -> the targeted row id
  const renameFroms = new Set<string>() // normalized from-labels that came from a rename_person
  for (const c of corrections) {
    const ft = fromTo(c)
    if (!ft) continue
    const fromNorm = normalizeLabel(ft.from)
    edge.set(fromNorm, ft.to)
    if (ft.fromId) fromIds.set(fromNorm, ft.fromId)
    if (c.kind === 'rename_person') renameFroms.add(fromNorm)
  }

  const resolveFinal = (startNorm: string): string => {
    let label = edge.get(startNorm) as string
    const seen = new Set<string>([startNorm])
    for (;;) {
      const nextNorm = normalizeLabel(label)
      if (seen.has(nextNorm)) return label // cycle guard: stop at the current target
      const next = edge.get(nextNorm)
      if (next === undefined) return label
      seen.add(nextNorm)
      label = next
    }
  }

  const labelToFinal = new Map<string, string>()
  for (const fromNorm of edge.keys()) labelToFinal.set(fromNorm, resolveFinal(fromNorm))

  // Identify each loser row: prefer the id the correction payload carries (the row
  // the user targeted), falling back to the first+last label hash (lockstep with
  // the people pass's non-resolver id path) for old corrections without ids. The
  // SURVIVOR is recorded as a label only; its real row id is resolved after the
  // people pass by resolveSurvivorIds, so supersession can never point at an id
  // that does not exist.
  const loserToSurvivorLabel = new Map<string, string>()
  const renameTargets = new Map<string, string>()
  for (const [fromNorm, finalLabel] of labelToFinal) {
    if (normalizeLabel(finalLabel) === fromNorm) continue // chain landed back on itself
    const lf = splitName(fromNorm)
    const loserId = fromIds.get(fromNorm) || canonicalPersonId(userId, lf.first, lf.last)
    loserToSurvivorLabel.set(loserId, finalLabel)
    // Only a rename_person target is an in-place relabel; a merge loser must never be
    // relabeled (it is superseded onto the into row, or left current when that row is
    // absent). Guarded so applyRenameLabels cannot corrupt a merge loser.
    if (renameFroms.has(fromNorm)) renameTargets.set(loserId, finalLabel)
  }

  const fingerprint = corrections.length
    ? sha256(canonicalJson(corrections.map((c) => ({ k: c.kind, p: c.payload }))))
    : ''

  return { labelToFinal, loserToSurvivorLabel, renameTargets, fingerprint }
}

// Resolve each survivor LABEL to the actual current row that carries it, after the
// people pass has written. A survivor that did not materialize (the model emitted
// the person under yet another label) is logged and SKIPPED: the loser stays
// current rather than being retired onto a dangling pointer. Idempotent and cheap.
export async function resolveSurvivorIds(
  userId: string,
  loserToSurvivorLabel: Map<string, string>
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (loserToSurvivorLabel.size === 0) return out
  const { data, error } = await admin()
    .from(PEOPLE_TABLE)
    .select('id, label')
    .eq('user_id', userId)
    .is('valid_to', null)
  if (error) throw new Error(`[miner] read people for survivor resolution: ${error.message}`)
  const byNorm = new Map<string, string>()
  for (const r of (data ?? []) as Array<{ id: string; label: string | null }>) {
    if (r.label) byNorm.set(normalizeLabel(r.label), String(r.id))
  }
  for (const [loserId, survivorLabel] of loserToSurvivorLabel) {
    const survivorId = byNorm.get(normalizeLabel(survivorLabel))
    if (!survivorId) {
      console.warn(
        `[miner] correction survivor "${survivorLabel}" has no current row after the people pass; ` +
          `leaving loser ${loserId} current (no dangling supersession)`
      )
      continue
    }
    if (survivorId === loserId) continue
    out.set(loserId, survivorId)
  }
  return out
}

// Apply the rewrite to a resolved node name: the survivor label, or the original
// if no correction touches it.
export function rewriteLabel(rw: PeopleRewrite, name: string): string {
  return rw.labelToFinal.get(normalizeLabel(name)) ?? name
}

const nowIso = () => new Date().toISOString()

// Retire each stale loser person row by superseding it (valid_to = now,
// superseded_by = survivor). Only touches rows that are currently current, so it
// is a one-time op per correction and a clean no-op on later runs. The survivor
// already carries the unioned provenance because the label rewrite reroutes every
// loser-named claim onto the survivor's id on every recompute.
export async function supersedeLosers(userId: string, loserToSurvivor: Map<string, string>): Promise<number> {
  let superseded = 0
  for (const [loserId, survivorId] of loserToSurvivor) {
    const { data, error } = await admin()
      .from(PEOPLE_TABLE)
      .update({ valid_to: nowIso(), superseded_by: survivorId })
      .eq('user_id', userId)
      .eq('id', loserId)
      .is('valid_to', null)
      .select('id')
    if (error) throw new Error(`[miner] supersede loser ${loserId}: ${error.message}`)
    superseded += (data ?? []).length
  }
  return superseded
}

// Force the target label onto a rename that resolved IN PLACE. The stable-identity
// resolver keeps a row's id when the rename target is already one of its aliases or a
// close fuzzy match (a typo fix like "Sean Yanka" -> "Sean Janka", or the Karalea
// case once "Karalea" is a known alias). The people pass sets the row's label to the
// target, but writeCanonical's change-signature deliberately EXCLUDES the label (LLM
// label-casing churn control), so a pure relabel with an unchanged claim set is
// treated as "unchanged" and skipped, and the rename would never land in canonical.
// This applies it directly. It only touches CURRENT rows whose label still differs
// (a superseded loser from a real merge is left retired, and it is a clean no-op once
// applied). idToFinalLabel is the rewrite's loser-id -> final-survivor-label map,
// whose in-place entries are exactly the rows that keep their id.
export async function applyRenameLabels(userId: string, idToFinalLabel: Map<string, string>): Promise<number> {
  if (idToFinalLabel.size === 0) return 0
  const ids = Array.from(idToFinalLabel.keys())
  let relabeled = 0
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { data, error } = await admin()
      .from(PEOPLE_TABLE)
      .select('id, label, data')
      .eq('user_id', userId)
      .is('valid_to', null)
      .in('id', chunk)
    if (error) throw new Error(`[miner] read people for rename label: ${error.message}`)
    for (const r of (data ?? []) as Array<{ id: string; label: string | null; data: Record<string, unknown> | null }>) {
      const finalLabel = idToFinalLabel.get(String(r.id))
      if (!finalLabel) continue
      if (normalizeLabel(r.label ?? '') === normalizeLabel(finalLabel)) continue // already applied
      const d = r.data ?? {}
      const split = splitName(finalLabel)
      // keep the old surface form as an alias so the row is still searchable by it
      const aliases = uniqArray([...(Array.isArray(d.aliases) ? d.aliases : []), ...(r.label ? [r.label] : [])])
      const { error: uerr } = await admin()
        .from(PEOPLE_TABLE)
        .update({ label: finalLabel, data: { ...d, first_name: split.first, last_name: split.last, aliases } })
        .eq('user_id', userId)
        .eq('id', r.id)
        .is('valid_to', null)
      if (uerr) throw new Error(`[miner] apply rename label ${r.id}: ${uerr.message}`)
      relabeled++
    }
  }
  return relabeled
}

// Retire current relationship edges that still reference a loser person id. The
// re-resolution emits the survivor edge under a new id, so the stale loser edge is
// what is left to retire. A no-op when there are no losers.
export async function retireStaleRelationships(userId: string, loserIds: Set<string>): Promise<number> {
  if (loserIds.size === 0) return 0
  let retired = 0
  for (const { table, refsOf } of RETIRE_TABLES) {
    const { data, error } = await admin()
      .from(table)
      .select('id, data')
      .eq('user_id', userId)
      .is('valid_to', null)
    if (error) throw new Error(`[miner] read ${table} for retire: ${error.message}`)
    const staleIds = (data ?? [])
      .filter((r) => refsOf((r as { data: Record<string, unknown> | null }).data ?? {}).some((id) => loserIds.has(id)))
      .map((r) => String((r as { id: string }).id))
    for (let i = 0; i < staleIds.length; i += 200) {
      const chunk = staleIds.slice(i, i + 200)
      const { error: uerr } = await admin()
        .from(table)
        .update({ valid_to: nowIso() })
        .eq('user_id', userId)
        .in('id', chunk)
        .is('valid_to', null)
      if (uerr) throw new Error(`[miner] retire ${table}: ${uerr.message}`)
      retired += chunk.length
    }
  }
  return retired
}

// Repoint embedded person references (commitment.person_id, project/event
// related_ids, insight.affected_entity_ids) from a loser id to its survivor, in
// place. These rows are label-keyed, so re-resolution reuses the same id and
// writeCanonical skips the data-only change; rewriting the reference here makes the
// merge survive without dropping the row. Idempotent: once repointed there are no
// loser refs left, so later runs touch nothing.
export async function repointReferences(userId: string, loserToSurvivor: Map<string, string>): Promise<number> {
  if (loserToSurvivor.size === 0) return 0
  let repointed = 0
  for (const spec of REPOINT_SPECS) {
    const { data, error } = await admin()
      .from(spec.table)
      .select('id, data')
      .eq('user_id', userId)
      .is('valid_to', null)
    if (error) throw new Error(`[miner] read ${spec.table} for repoint: ${error.message}`)
    for (const r of (data ?? []) as Array<{ id: string; data: Record<string, unknown> | null }>) {
      const d = r.data ?? {}
      const next: Record<string, unknown> = { ...d }
      let changed = false
      for (const f of spec.scalarFields ?? []) {
        const v = asStr(d[f])
        if (v && loserToSurvivor.has(v)) {
          next[f] = loserToSurvivor.get(v)
          changed = true
        }
      }
      for (const f of spec.arrayFields ?? []) {
        if (!Array.isArray(d[f])) continue
        const mapped = (d[f] as unknown[]).map((x) => {
          const s = asStr(x)
          return s && loserToSurvivor.has(s) ? loserToSurvivor.get(s) : x
        })
        const deduped = uniqArray(mapped)
        if (JSON.stringify(deduped) !== JSON.stringify(d[f])) {
          next[f] = deduped
          changed = true
        }
      }
      if (!changed) continue
      const { error: uerr } = await admin()
        .from(spec.table)
        .update({ data: next })
        .eq('user_id', userId)
        .eq('id', r.id)
        .is('valid_to', null)
      if (uerr) throw new Error(`[miner] repoint ${spec.table} ${r.id}: ${uerr.message}`)
      repointed++
    }
  }
  return repointed
}
