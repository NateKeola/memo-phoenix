// @memo/miner-core — the personal-schema miner.
//
// A deterministic pipeline (the LLM is one stage, not the orchestrator):
//   captures -> raw_* (extraction)  ->  canonical_* (Stage A -> B -> C)
// Recompute is id-preserving (deterministic UUIDv5) and memoized, so a second run
// over unchanged input is a no-op. Provenance (source_claim_ids) is mandatory.

export { mine, mineWithLock, assertUserId, type MineSummary, type MineRunResult } from './run'
export { runDerivation } from './derive'
// Incremental derivation (MINER_INCREMENTAL, default OFF). mergeEmitted is the pure
// merge used by the deterministic equivalence check.
export { INCREMENTAL, runIncrementalDerivation, mergeEmitted, type IncrementalMode } from './incremental'
// Stable-identity resolution (deterministic-id hardening). The pure helpers are
// exported for the offline resolution check; the DB-backed Resolver wiring runs
// inside the miner.
export {
  Resolver,
  resolveId,
  tokens,
  jaccard,
  STRICT_FUZZY,
  CONTEXT_FUZZY,
  type ResolveCandidate,
  type ResolveVia,
} from './resolution'
export { extractCapture, type Capture, type ExtractResult } from './extract'
export type { PassResult, CanonicalRow, TemporalClass, Usage, DiscrepancyItem } from './types'
// Freshness loop (spec §3, PR8). The pure helpers (computeSalience, newestClaimMs,
// SALIENCE) are exported for the offline check; the DB jobs run inside the miner.
export {
  computeSalience,
  newestClaimMs,
  planSupersessions,
  loadClaimDates,
  reconcileFreshness,
  supersedeFromDiscrepancies,
  SALIENCE,
  type SalienceSignals,
} from './freshness'
