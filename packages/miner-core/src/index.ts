// @memo/miner-core — PR0 stub.
//
// The miner engine (Stage A -> B -> C, recompute from the full ground-truth set,
// provenance, history, pagination, two-round verification) is ported in PR1.
// PR0 only establishes the engine boundary as its own package (spec decision #10),
// so nothing here does real work yet.

export type MinerStage = 'A' | 'B' | 'C'

// The ground-truth set the miner recomputes from on every run: raw claims plus
// the user's append-only corrections and freshness confirmations. (Invariant 3.)
export type GroundTruthSet = {
  raw: unknown[]
  corrections: unknown[]
  confirmations: unknown[]
}

export type MinerRunResult = {
  ranStages: MinerStage[]
}

// No-op placeholder. The real dependency-ordered pipeline lands in PR1.
export async function run(_input: GroundTruthSet): Promise<MinerRunResult> {
  return { ranStages: [] }
}
