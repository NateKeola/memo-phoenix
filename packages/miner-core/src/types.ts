export type TemporalClass = 'evergreen' | 'dated' | 'decaying'

export type RawClaim = { id: string; data: Record<string, unknown> }

// A contradiction the resolution model flagged between two (or more) raw claims.
// The freshness loop maps claim_ids to the canonical rows that cite them and
// supersedes the older when the conflict produced two distinct current rows.
export type DiscrepancyItem = { subject: string | null; description: string | null; claim_ids: string[] }

// A node as the resolution model emits it (before we attach a deterministic id).
export type ModelNode = {
  name?: unknown
  summary?: unknown
  aliases?: unknown
  data?: unknown
  source_claim_ids?: unknown
  confidence?: unknown
  temporality?: unknown
  // edges (relationships)
  source_id?: unknown
  target_id?: unknown
  relation?: unknown
  // insights
  statement?: unknown
  pattern_type?: unknown
  supporting_claim_ids?: unknown
  affected_entity_ids?: unknown
}

// A fully-formed canonical row ready to upsert (the loose PR0 shape).
export type CanonicalRow = {
  id: string
  user_id: string
  label: string | null
  data: Record<string, unknown>
  source_claim_ids: string[]
  temporality: TemporalClass
  confidence: number
  salience: number
  summary: string | null
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export type PassResult = {
  table: string
  skipped: boolean // memoized: input unchanged since last run
  inserted: number
  updated: number
  unchanged: number
  rows: number
  batches: number
  discrepancies: number
  open_threads: number
  usage: Usage
  // the discrepancy items themselves (not just the count), so derivation can drive
  // supersession from them. Empty for passes that emit none.
  discrepancyItems?: DiscrepancyItem[]
}

export const emptyUsage = (): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  }
}
