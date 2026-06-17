// @memo/miner-core — the personal-schema miner.
//
// A deterministic pipeline (the LLM is one stage, not the orchestrator):
//   captures -> raw_* (extraction)  ->  canonical_* (Stage A -> B -> C)
// Recompute is id-preserving (deterministic UUIDv5) and memoized, so a second run
// over unchanged input is a no-op. Provenance (source_claim_ids) is mandatory.

export { mine, type MineSummary } from './run'
export { runDerivation } from './derive'
export { extractCapture, type Capture, type ExtractResult } from './extract'
export type { PassResult, CanonicalRow, TemporalClass, Usage } from './types'
