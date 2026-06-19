import { MAX_BATCHES, MAX_BATCH_ATTEMPTS, pageLimit } from './config'
import { callClaude, parseModelObject } from './anthropic'
import { admin } from './supabase'
import { canonicalJson, sha256 } from './identity'
import { addUsage, emptyUsage, type DiscrepancyItem, type ModelNode, type Usage } from './types'

// ---- reads ------------------------------------------------------------------

export async function readRawClaims(
  userId: string,
  table: string
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const { data, error } = await admin()
    .from(table)
    .select('id, data')
    .eq('user_id', userId)
  if (error) throw new Error(`[miner] read ${table}: ${error.message}`)
  return (data ?? []).map((r) => ({
    id: String((r as { id: string }).id),
    data: ((r as { data: Record<string, unknown> }).data ?? {}) as Record<string, unknown>,
  }))
}

export type CanonNode = {
  id: string
  label: string | null
  aliases: string[]
  type: string
  summary: string | null
  source_claim_ids: string[]
}

export async function readCanonicalNodes(userId: string, table: string): Promise<CanonNode[]> {
  const { data, error } = await admin()
    .from(table)
    .select('id, label, data, summary, source_claim_ids')
    .eq('user_id', userId)
    .is('valid_to', null)
  if (error) throw new Error(`[miner] read ${table}: ${error.message}`)
  return (data ?? []).map((r) => {
    const row = r as {
      id: string
      label: string | null
      data: { aliases?: unknown } | null
      summary: string | null
      source_claim_ids: string[] | null
    }
    return {
      id: String(row.id),
      label: row.label,
      aliases: asStringArray(row.data?.aliases),
      type: table.replace(/^canonical_/, ''),
      summary: row.summary,
      source_claim_ids: row.source_claim_ids ?? [],
    }
  })
}

// ---- memoization (miner_state) ---------------------------------------------
// A second run over unchanged input is a no-op: same input hash → skip the LLM
// pass and the write entirely, so canonical_history is never churned.

export function inputHash(parts: unknown[]): string {
  return sha256(canonicalJson(parts))
}

export async function getState(userId: string, scope: string): Promise<string | null> {
  const { data, error } = await admin()
    .from('miner_state')
    .select('input_hash')
    .eq('user_id', userId)
    .eq('scope', scope)
    .maybeSingle()
  if (error) throw new Error(`[miner] read miner_state ${scope}: ${error.message}`)
  return (data as { input_hash: string } | null)?.input_hash ?? null
}

export async function setState(userId: string, scope: string, hash: string): Promise<void> {
  const { error } = await admin()
    .from('miner_state')
    .upsert(
      { user_id: userId, scope, input_hash: hash, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,scope' }
    )
  if (error) throw new Error(`[miner] write miner_state ${scope}: ${error.message}`)
}

// ---- pagination -------------------------------------------------------------

export type PaginatedCollect = {
  items: Array<Record<string, unknown>>
  discrepancies: number
  // the discrepancy items themselves (deduped), so derivation can act on them
  discrepancyItems: DiscrepancyItem[]
  open_threads: number
  usage: Usage
  batches: number
}

// Pull the {subject, description, claim_ids} shape out of a raw discrepancy object,
// keeping only ids that are real strings. Returns null when there is nothing usable.
function parseDiscrepancy(v: unknown): DiscrepancyItem | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const claim_ids = uniqueStrings(o.claim_ids)
  if (claim_ids.length < 2) return null // a contradiction needs at least two claims
  return { subject: asString(o.subject), description: asString(o.description), claim_ids }
}

// Loop LLM calls until the model signals has_more:false or stops adding new
// items. Each batch is retried up to MAX_BATCH_ATTEMPTS on bad JSON / bad
// provenance, so an occasional malformed response never dooms the run.
export async function paginatedCollect(opts: {
  ctx: string
  system: string
  itemsField: 'nodes' | 'edges' | 'insights'
  labelOf: (item: Record<string, unknown>) => string | null
  // build the user message given what was already emitted + the batch cap
  buildUser: (alreadyEmitted: string[], batchLimit: number) => string
  validate?: (batchItems: Array<Record<string, unknown>>) => void
}): Promise<PaginatedCollect> {
  const items: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  const already: string[] = []
  const batchLimit = pageLimit()
  let usage = emptyUsage()
  let discrepancies = 0
  const discrepancyItems: DiscrepancyItem[] = []
  const discSeen = new Set<string>()
  let openThreads = 0
  let batches = 0

  for (let i = 0; i < MAX_BATCHES; i++) {
    const user = opts.buildUser(already, batchLimit)
    let out: Record<string, unknown> | null = null
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
      const res = await callClaude(opts.system, user)
      usage = addUsage(usage, res.usage)
      try {
        const parsed = parseModelObject(res.raw, `${opts.ctx} batch ${i + 1}`)
        const batch = Array.isArray(parsed[opts.itemsField])
          ? (parsed[opts.itemsField] as Array<Record<string, unknown>>)
          : []
        if (opts.validate) opts.validate(batch)
        out = parsed
        break
      } catch (err) {
        lastErr = err
        if (attempt < MAX_BATCH_ATTEMPTS) {
          console.warn(
            `[miner] ${opts.ctx} batch ${i + 1} attempt ${attempt}/${MAX_BATCH_ATTEMPTS} failed: ${err instanceof Error ? err.message : String(err)}; retrying`
          )
        }
      }
    }
    batches++
    if (!out) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))

    const batch = Array.isArray(out[opts.itemsField])
      ? (out[opts.itemsField] as Array<Record<string, unknown>>)
      : []
    let fresh = 0
    for (const it of batch) {
      const label = opts.labelOf(it)
      const key = (label ?? JSON.stringify(it)).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      items.push(it)
      if (label) already.push(label)
      fresh++
    }
    if (Array.isArray(out.discrepancies)) {
      discrepancies += out.discrepancies.length
      for (const raw of out.discrepancies) {
        const parsed = parseDiscrepancy(raw)
        if (!parsed) continue
        const key = [...parsed.claim_ids].sort().join('|') // dedup across batches by the conflicting claim set
        if (discSeen.has(key)) continue
        discSeen.add(key)
        discrepancyItems.push(parsed)
      }
    }
    if (Array.isArray(out.open_threads)) openThreads += out.open_threads.length

    if (out.has_more !== true) break
    if (fresh === 0) break // no-progress guard
  }

  return { items, discrepancies, discrepancyItems, open_threads: openThreads, usage, batches }
}

// ---- provenance -------------------------------------------------------------

export function validateCited(cited: string[], known: Set<string>, ctx: string): void {
  for (const id of cited) {
    if (!known.has(id)) {
      throw new Error(`[miner] ${ctx}: cited unknown raw id ${id} (provenance must reference real claims)`)
    }
  }
}

export function uniqueStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out = new Set<string>()
  for (const x of v) if (typeof x === 'string' && x.trim()) out.add(x.trim())
  return Array.from(out)
}

export function asStringArray(v: unknown): string[] {
  return uniqueStrings(v)
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export function clamp01(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(1, n))
}

// salience from provenance weight: a node cited once starts at 0.3 and rises with
// how many claims support it. Conservative; tuned in V1/PR8.
export function salienceFrom(sourceCount: number): number {
  return round3(Math.max(0, Math.min(1, 0.3 + 0.1 * (sourceCount - 1))))
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

// ---- write path (id-preserving upsert, skip unchanged) ----------------------
// Deterministic ids mean a re-run touches the same rows. We only upsert rows
// whose content actually changed, so canonical_history captures real changes,
// not full-table churn.

type ExistingSig = { change: string; full: string; superseded: boolean }

// Change-detection keys ONLY on the meaningful resolution: the provenance set
// (which raw claims support the node) and the temporal class. The synthesized and
// cosmetic fields (summary, data wording, confidence, salience, label casing) are
// deliberately excluded. The LLM rewords those on every re-resolution, and letting
// that count as a "change" rewrites every row and floods canonical_history with
// churn. A row updates only when its claims or classification actually change,
// which is exactly when its summary should be re-synthesized anyway.
function changeSignature(row: { source_claim_ids: string[]; temporality: string }): string {
  return canonicalJson({ source_claim_ids: [...row.source_claim_ids].sort(), temporality: row.temporality })
}

// The full row signature (every persisted field). Used ONLY for the optional
// MINER_CHURN_DEBUG A/B counter, to report how much churn the old full signature
// would have produced versus the provenance-keyed signature.
function fullSignature(row: {
  label: string | null
  data: Record<string, unknown>
  source_claim_ids: string[]
  temporality: string
  confidence: number
  salience: number
  summary: string | null
}): string {
  return canonicalJson({
    label: row.label,
    data: row.data,
    source_claim_ids: [...row.source_claim_ids].sort(),
    temporality: row.temporality,
    confidence: round3(row.confidence),
    salience: round3(row.salience),
    summary: row.summary,
  })
}

export async function writeCanonical(
  userId: string,
  table: string,
  rows: Array<{
    id: string
    user_id: string
    label: string | null
    data: Record<string, unknown>
    source_claim_ids: string[]
    temporality: string
    confidence: number
    salience: number
    summary: string | null
  }>
): Promise<{ inserted: number; updated: number; unchanged: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0, unchanged: 0 }
  const debug = process.env.MINER_CHURN_DEBUG === '1'

  const ids = rows.map((r) => r.id)
  const existing = new Map<string, ExistingSig>()
  // Read the existing row per id INCLUDING superseded ones (an id is unique, so it
  // is either current or superseded, never both). We need to know about superseded
  // rows so a model re-emitting a retired node does not resurrect it (the freshness
  // loop closes a contradicted row's validity; re-inserting it would undo that).
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const { data, error } = await admin()
      .from(table)
      .select('id, label, data, source_claim_ids, temporality, confidence, salience, summary, valid_to')
      .eq('user_id', userId)
      .in('id', chunk)
    if (error) throw new Error(`[miner] read-existing ${table}: ${error.message}`)
    for (const e of (data ?? []) as ExistingRow[]) {
      const n = normalizeExisting(e)
      existing.set(String(e.id), {
        change: changeSignature(n),
        full: fullSignature(n),
        superseded: e.valid_to !== null,
      })
    }
  }

  let inserted = 0
  let updated = 0
  let unchanged = 0
  let resurrectSkipped = 0 // re-emitted rows we leave retired (validity already closed)
  let fullWouldWrite = 0 // MINER_CHURN_DEBUG: what the old full signature would rewrite
  const toWrite: typeof rows = []
  for (const r of rows) {
    const prev = existing.get(r.id)
    if (prev === undefined) {
      inserted++
      toWrite.push(r)
    } else if (prev.superseded) {
      // The row was retired (e.g. a contradicted fact). Leave it superseded; the
      // survivor carries the truth. Do not resurrect or rewrite it.
      resurrectSkipped++
    } else if (prev.change !== changeSignature(r)) {
      updated++
      toWrite.push(r)
    } else {
      unchanged++
    }
    if (debug && (prev === undefined || (!prev.superseded && prev.full !== fullSignature(r)))) fullWouldWrite++
  }

  for (let i = 0; i < toWrite.length; i += 500) {
    const chunk = toWrite.slice(i, i + 500)
    const { error } = await admin().from(table).upsert(chunk, { onConflict: 'id' })
    if (error) throw new Error(`[miner] upsert ${table}: ${error.message}`)
  }

  if (debug) {
    console.log(
      `[churn] ${table}: provenance-sig writes=${toWrite.length} ` +
        `(ins ${inserted}/upd ${updated}/unchanged ${unchanged}/retired-kept ${resurrectSkipped}); old full-sig would write=${fullWouldWrite}`
    )
  }
  return { inserted, updated, unchanged }
}

type ExistingRow = {
  id: string
  label: string | null
  data: Record<string, unknown> | null
  source_claim_ids: string[] | null
  temporality: string
  confidence: number | null
  salience: number | null
  summary: string | null
  valid_to: string | null
}

function normalizeExisting(e: ExistingRow) {
  return {
    label: e.label,
    data: (e.data ?? {}) as Record<string, unknown>,
    source_claim_ids: e.source_claim_ids ?? [],
    temporality: e.temporality,
    confidence: e.confidence ?? 0,
    salience: e.salience ?? 0,
    summary: e.summary,
  }
}

export type { ModelNode }
