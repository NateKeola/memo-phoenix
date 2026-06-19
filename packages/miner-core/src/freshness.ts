// The freshness loop (spec §3, PR8): the deterministic, code-side half of the
// self-refreshing corpus. The LLM is still just a pipeline stage; everything here
// is deterministic.
//
// Three jobs, all run at the end of a recompute (derive.ts), after the A/B/C
// passes have written the current canonical layer:
//
//  1. last_confirmed_at maintenance. Each node's decay anchor is the date of its
//     newest supporting capture (the newest source claim). Confidence DECAY itself
//     is computed at READ time from this anchor (lib/freshness in the app), never
//     persisted, so a moving clock never floods canonical_history with churn. The
//     miner's decay job is to keep the anchor correct.
//
//  2. Salience scoring. A transparent score per node from documented signals:
//     provenance weight, graph degree, how many rows reference it, and whether it
//     is load-bearing for an open commitment. Persisted to the salience column so
//     reconfirm selection and retrieval can rank by it. Updated only when it
//     actually changes (the graph changed), so churn stays bounded.
//
//  3. Supersession from discrepancies. When the resolution model flags a
//     contradiction (it already emits `discrepancies: [{subject, description,
//     claim_ids}]`), and the conflicting claims landed in two different CURRENT
//     rows, the older row's validity window is closed (valid_to = now,
//     superseded_by = the newer row) instead of holding both as current. Keyed on
//     claim ids, not labels, so it is robust to label drift.
//
// ID-DRIFT CAVEAT (for the later id-hardening PR): decay/salience are keyed on the
// node's deterministic label-derived id. If a label drifts the id changes and a
// NEW row is minted; the freshness job then ages/scores whatever current row
// exists, which is correct for the new row but loses the old row's decay history.
// Supersession is keyed on claim ids so it survives label drift better. Renewal
// (the user re-confirming a fact) relies on the answer resolving to the SAME id;
// if the label drifts between mention and re-mention, the renewal lands on a new
// id and the aging row is missed. See the decision log.

import { admin } from './supabase'
import { round3 } from './stage-common'
import { repointReferences } from './corrections'
import type { DiscrepancyItem } from './types'

// All raw tables, for resolving a claim id to its originating capture's date.
const RAW_TABLES = [
  'raw_people',
  'raw_places_orgs',
  'raw_projects',
  'raw_events',
  'raw_facts',
  'raw_relationships',
  'raw_commitments',
  'raw_collection_mentions',
]

// Entity/edge tables that carry the shared block and can age. (collections live
// elsewhere and are not part of the freshness loop.)
const FRESHNESS_TABLES = [
  'canonical_people',
  'canonical_places_orgs',
  'canonical_projects',
  'canonical_events',
  'canonical_facts',
  'canonical_relationships',
  'canonical_commitments',
  'insights',
]

// ---- salience config (documented, tunable) ---------------------------------
// Salience = weighted sum of normalized signals, clamped to [0,1]. Starting
// values; tuned by feel (env-overridable for experiments). The weights sum to 1.
const num = (name: string, dflt: number): number => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= 0 ? n : dflt
}
export const SALIENCE = {
  // how much of each signal counts toward the score
  wProvenance: num('SALIENCE_W_PROVENANCE', 0.3), // how much evidence supports it
  wDegree: num('SALIENCE_W_DEGREE', 0.35), // how connected it is in the graph
  wReferences: num('SALIENCE_W_REFERENCES', 0.25), // how many rows point at it
  wCommitment: num('SALIENCE_W_COMMITMENT', 0.1), // load-bearing for an open commitment
  // a signal hits its full weight at this count (saturating normalizer)
  provenanceFull: num('SALIENCE_PROVENANCE_FULL', 4),
  degreeFull: num('SALIENCE_DEGREE_FULL', 4),
  referencesFull: num('SALIENCE_REFERENCES_FULL', 3),
}

const sat = (count: number, full: number): number => (full <= 0 ? 0 : Math.min(1, count / full))

export type SalienceSignals = {
  provenance: number // count of source claims
  degree: number // count of relationship edges touching the node
  references: number // count of other rows referencing the node id
  commitmentLoad: boolean // referenced by a current open commitment
}

// Transparent, inspectable salience score. Exported so the offline check can
// assert it ranks nodes sensibly.
export function computeSalience(s: SalienceSignals): number {
  const score =
    SALIENCE.wProvenance * sat(s.provenance, SALIENCE.provenanceFull) +
    SALIENCE.wDegree * sat(s.degree, SALIENCE.degreeFull) +
    SALIENCE.wReferences * sat(s.references, SALIENCE.referencesFull) +
    SALIENCE.wCommitment * (s.commitmentLoad ? 1 : 0)
  return round3(Math.max(0, Math.min(1, score)))
}

// ---- claim -> capture date --------------------------------------------------

function asStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

// Map every raw claim id to its capture's created_at (epoch ms). One pass over the
// raw tables plus the captures, shared by the decay anchor and supersession.
export async function loadClaimDates(userId: string): Promise<Map<string, number>> {
  const claimToCapture = new Map<string, string>()
  for (const t of RAW_TABLES) {
    const { data, error } = await admin().from(t).select('id, capture_id').eq('user_id', userId)
    if (error) throw new Error(`[miner] freshness read ${t}: ${error.message}`)
    for (const r of (data ?? []) as Array<{ id: string; capture_id: string }>) {
      if (r.capture_id) claimToCapture.set(String(r.id), String(r.capture_id))
    }
  }
  const { data: caps, error: cErr } = await admin().from('captures').select('id, created_at').eq('user_id', userId)
  if (cErr) throw new Error(`[miner] freshness read captures: ${cErr.message}`)
  const captureDate = new Map<string, number>()
  for (const c of (caps ?? []) as Array<{ id: string; created_at: string }>) {
    const ms = Date.parse(c.created_at)
    if (!Number.isNaN(ms)) captureDate.set(String(c.id), ms)
  }
  const out = new Map<string, number>()
  for (const [claimId, capId] of claimToCapture) {
    const ms = captureDate.get(capId)
    if (ms !== undefined) out.set(claimId, ms)
  }
  return out
}

// Newest supporting capture date for a node, or null if none of its claims have a
// resolvable date.
export function newestClaimMs(claimIds: string[], dateMap: Map<string, number>): number | null {
  let max: number | null = null
  for (const id of claimIds) {
    const ms = dateMap.get(id)
    if (ms !== undefined && (max === null || ms > max)) max = ms
  }
  return max
}

// ---- reconciliation: last_confirmed_at + salience ---------------------------

type FreshRow = {
  id: string
  source_claim_ids: string[]
  data: Record<string, unknown>
  salience: number | null
  last_confirmed_at: string | null
}

export type ReconcileResult = { lastConfirmedUpdated: number; salienceUpdated: number; renewed: number }

export async function reconcileFreshness(
  userId: string,
  dateMap: Map<string, number>
): Promise<ReconcileResult> {
  // Load the full current layer once. We need data for reference/degree signals.
  const byTable = new Map<string, FreshRow[]>()
  for (const table of FRESHNESS_TABLES) {
    const { data, error } = await admin()
      .from(table)
      .select('id, source_claim_ids, data, salience, last_confirmed_at')
      .eq('user_id', userId)
      .is('valid_to', null)
    if (error) throw new Error(`[miner] freshness read ${table}: ${error.message}`)
    byTable.set(
      table,
      (data ?? []).map((r) => {
        const row = r as {
          id: string
          source_claim_ids: string[] | null
          data: Record<string, unknown> | null
          salience: number | null
          last_confirmed_at: string | null
        }
        return {
          id: String(row.id),
          source_claim_ids: row.source_claim_ids ?? [],
          data: (row.data ?? {}) as Record<string, unknown>,
          salience: row.salience,
          last_confirmed_at: row.last_confirmed_at,
        }
      })
    )
  }

  // --- build the graph signal maps from the loaded layer ---
  const degree = new Map<string, number>() // node id -> edge count
  for (const r of byTable.get('canonical_relationships') ?? []) {
    const s = asStr(r.data.source_id)
    const t = asStr(r.data.target_id)
    if (s) degree.set(s, (degree.get(s) ?? 0) + 1)
    if (t) degree.set(t, (degree.get(t) ?? 0) + 1)
  }

  const references = new Map<string, number>() // node id -> structural connectivity
  const openCommitmentRefs = new Set<string>() // node ids load-bearing for an open commitment
  const bump = (id: string) => {
    if (id) references.set(id, (references.get(id) ?? 0) + 1)
  }
  // A structural reference connects two nodes; BOTH ends gain connectivity, so a
  // project or event that links out to several people is salient in its own right,
  // not just the people it points at. (Decaying nodes are mostly projects/facts,
  // so crediting only incoming references would leave them unscored.)
  const link = (from: string, to: string) => {
    if (from && to) {
      bump(from)
      bump(to)
    }
  }
  for (const r of byTable.get('canonical_commitments') ?? []) {
    const pid = asStr(r.data.person_id)
    link(r.id, pid)
    const done = asStr(r.data.status).toLowerCase() === 'done'
    if (pid && !done) openCommitmentRefs.add(pid)
  }
  for (const table of ['canonical_projects', 'canonical_events']) {
    for (const r of byTable.get(table) ?? []) {
      for (const x of Array.isArray(r.data.related_ids) ? (r.data.related_ids as unknown[]) : []) link(r.id, asStr(x))
    }
  }
  for (const r of byTable.get('insights') ?? []) {
    for (const x of Array.isArray(r.data.affected_entity_ids) ? (r.data.affected_entity_ids as unknown[]) : []) link(r.id, asStr(x))
  }

  // --- compute target last_confirmed_at + salience per row, update only diffs ---
  let lastConfirmedUpdated = 0
  let salienceUpdated = 0
  let renewed = 0
  for (const table of FRESHNESS_TABLES) {
    for (const r of byTable.get(table) ?? []) {
      const ms = newestClaimMs(r.source_claim_ids, dateMap)
      // Compare the anchor by INSTANT, not string: Postgres returns timestamptz as
      // "...+00:00" while Date.toISOString() yields "...Z", so a string compare
      // would rewrite the same instant on every run (churn). Salience is numeric,
      // so it compares cleanly.
      const prevRaw = r.last_confirmed_at ? Date.parse(r.last_confirmed_at) : NaN
      const prevMs = Number.isNaN(prevRaw) ? null : prevRaw
      const lcChanged = (ms ?? null) !== prevMs
      const targetLc = ms === null ? null : new Date(ms).toISOString()
      const targetSal = computeSalience({
        provenance: r.source_claim_ids.length,
        degree: degree.get(r.id) ?? 0,
        references: references.get(r.id) ?? 0,
        commitmentLoad: openCommitmentRefs.has(r.id),
      })
      const salChanged = round3(r.salience ?? 0) !== targetSal
      if (!lcChanged && !salChanged) continue

      const patch: Record<string, unknown> = {}
      if (lcChanged) patch.last_confirmed_at = targetLc
      if (salChanged) patch.salience = targetSal
      const { error } = await admin()
        .from(table)
        .update(patch)
        .eq('user_id', userId)
        .eq('id', r.id)
        .is('valid_to', null)
      if (error) throw new Error(`[miner] freshness update ${table} ${r.id}: ${error.message}`)
      if (lcChanged) {
        lastConfirmedUpdated++
        if (ms !== null && (prevMs === null || ms > prevMs)) renewed++ // the decay clock moved forward
      }
      if (salChanged) salienceUpdated++
    }
  }
  return { lastConfirmedUpdated, salienceUpdated, renewed }
}

// ---- supersession from discrepancies ---------------------------------------

export type SupersedeResult = { superseded: number; repointed: number }

// Pure decision logic, extracted so it is testable offline. Given the current rows
// of one table (each with its supporting claim ids) and the discrepancies the
// model flagged for that table, decide which rows to supersede. For each
// discrepancy, the conflicting claim ids are mapped to the current rows that cite
// them; when two or more distinct rows are involved, the one backed by the newest
// capture wins and the STRICTLY older ones are retired onto it. A discrepancy
// whose claims all landed in one row (the model merged the conflict) supersedes
// nothing. Returns loser id -> survivor id.
export function planSupersessions(
  rows: Array<{ id: string; claims: string[] }>,
  items: DiscrepancyItem[],
  dateMap: Map<string, number>
): Map<string, string> {
  const loserToSurvivor = new Map<string, string>()
  const claimToRows = new Map<string, Set<string>>()
  for (const row of rows) for (const c of row.claims) {
    if (!claimToRows.has(c)) claimToRows.set(c, new Set())
    claimToRows.get(c)!.add(row.id)
  }
  const newest = new Map<string, number>()
  for (const row of rows) newest.set(row.id, newestClaimMs(row.claims, dateMap) ?? -Infinity)

  for (const item of items) {
    const involved = new Set<string>()
    for (const c of item.claim_ids) for (const rid of claimToRows.get(c) ?? []) involved.add(rid)
    if (involved.size < 2) continue // model merged the conflict, or only one side resolved
    let survivor: string | null = null
    let survivorMs = -Infinity
    for (const rid of involved) {
      const ms = newest.get(rid) ?? -Infinity
      if (ms > survivorMs) {
        survivorMs = ms
        survivor = rid
      }
    }
    if (!survivor || survivorMs === -Infinity) continue // need a dated survivor to compare against
    for (const rid of involved) {
      if (rid === survivor) continue
      if ((newest.get(rid) ?? -Infinity) < survivorMs) loserToSurvivor.set(rid, survivor) // strictly older only
    }
  }
  return loserToSurvivor
}

// Process the contradictions the resolution model flagged, closing the validity
// window of the older contradicted rows (valid_to = now, superseded_by = the
// newer row) instead of holding both as current. Keyed on claim ids, so it is
// robust to label drift. Idempotent: a superseded loser is no longer current, so
// a later run sees only the survivor and does nothing.
export async function supersedeFromDiscrepancies(
  userId: string,
  perTable: Array<{ table: string; items: DiscrepancyItem[] }>,
  dateMap: Map<string, number>
): Promise<SupersedeResult> {
  const globalLoserToSurvivor = new Map<string, string>()
  let superseded = 0

  for (const { table, items } of perTable) {
    if (!items.length) continue
    const { data, error } = await admin()
      .from(table)
      .select('id, source_claim_ids')
      .eq('user_id', userId)
      .is('valid_to', null)
    if (error) throw new Error(`[miner] supersede read ${table}: ${error.message}`)
    const rows = (data ?? []).map((r) => ({
      id: String((r as { id: string }).id),
      claims: ((r as { source_claim_ids: string[] | null }).source_claim_ids ?? []) as string[],
    }))
    const plan = planSupersessions(rows, items, dateMap)
    for (const [loserId, survivorId] of plan) {
      const { data: closed, error: uErr } = await admin()
        .from(table)
        .update({ valid_to: new Date().toISOString(), superseded_by: survivorId })
        .eq('user_id', userId)
        .eq('id', loserId)
        .is('valid_to', null)
        .select('id')
      if (uErr) throw new Error(`[miner] supersede ${table} ${loserId}: ${uErr.message}`)
      superseded += (closed ?? []).length
      globalLoserToSurvivor.set(loserId, survivorId)
    }
  }

  // repoint any downstream person-references off a superseded id (a no-op for the
  // common non-person supersession; safe and idempotent either way).
  const repointed = globalLoserToSurvivor.size > 0 ? await repointReferences(userId, globalLoserToSurvivor) : 0
  return { superseded, repointed }
}
