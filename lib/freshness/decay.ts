// The read-time half of the freshness loop (spec §3, PR8).
//
// Confidence DECAY is computed here, at read time, from a node's stored base
// confidence and its decay anchor (last_confirmed_at, maintained by the miner).
// It is never persisted: a value that changes every moment would flood
// canonical_history on every nightly recompute, which the whole architecture is
// built to avoid. Storing the anchor and deriving the effective value keeps
// canonical churn-free while still making decaying facts genuinely lose confidence
// over time.
//
// These constants are code config, tuned by feel. They are NOT in the database
// schema (per the open-decision to keep thresholds out of migrations).

const DAY_MS = 86_400_000

// Half-life in days per temporal class. Evergreen never decays. Dated items
// archive by their (free-text, unparseable) date rather than by confidence, so
// they are treated as non-decaying here; date-based archival is a later follow-up.
export const HALF_LIFE_DAYS: Record<string, number> = {
  decaying: 45,
}

// Reconfirm selection thresholds. A node is worth folding into the next interview
// as an "is this still true?" check when it is decaying, has aged below the
// confidence threshold, is salient enough to be worth asking about, and has not
// been confirmed too recently.
// salienceAbove is set below the ~0.30 a pure-provenance node (no graph links)
// tops out at, so a well-evidenced or well-connected decaying node clears it while
// one-off trivia (one or two mentions, no links) does not.
export const RECONFIRM = {
  confidenceBelow: 0.5,
  salienceAbove: 0.3,
  minStaleDays: 14,
  maxItems: 3,
}

// In retrieval, a current decaying fact whose effective confidence has dropped
// under this is marked "aged" / as-of, so the composer speaks of it as past
// ("as of <date>") rather than asserting it as present.
export const AGED_CONFIDENCE_BELOW = 0.5

export type FreshnessInput = {
  temporality: string
  confidence: number | null | undefined
  salience?: number | null
  lastConfirmedAt: string | null | undefined
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

// Days since the node was last confirmed, or null when there is no anchor.
export function ageDays(lastConfirmedAt: string | null | undefined, now: number): number | null {
  if (!lastConfirmedAt) return null
  const ms = Date.parse(lastConfirmedAt)
  if (Number.isNaN(ms)) return null
  return Math.max(0, (now - ms) / DAY_MS)
}

// Effective confidence after decay. Evergreen and dated do not decay. A decaying
// node loses half its base confidence every HALF_LIFE_DAYS since last confirmed.
// With no anchor we cannot decay it, so the base is returned.
export function effectiveConfidence(input: FreshnessInput, now: number): number {
  const base = clamp01(Number(input.confidence ?? 0))
  if (input.temporality !== 'decaying') return base
  const halfLife = HALF_LIFE_DAYS.decaying
  const days = ageDays(input.lastConfirmedAt, now)
  if (days === null || !(halfLife > 0)) return base
  return round3(base * Math.pow(0.5, days / halfLife))
}

// Is this node an "is this still true?" reconfirmation candidate?
export function isReconfirmCandidate(input: FreshnessInput, now: number): boolean {
  if (input.temporality !== 'decaying') return false
  if (effectiveConfidence(input, now) >= RECONFIRM.confidenceBelow) return false
  if ((Number(input.salience ?? 0)) < RECONFIRM.salienceAbove) return false
  const days = ageDays(input.lastConfirmedAt, now)
  if (days !== null && days < RECONFIRM.minStaleDays) return false // confirmed recently, leave it be
  return true
}

// A sort key for reconfirm candidates: the most-faded, most-salient first. Higher
// is more worth surfacing.
export function reconfirmPriority(input: FreshnessInput, now: number): number {
  const faded = 1 - effectiveConfidence(input, now) // how much confidence has been lost
  const sal = clamp01(Number(input.salience ?? 0))
  return round3(faded * 0.7 + sal * 0.3)
}

// In retrieval, should a current row be spoken of as past/uncertain?
export function isAged(input: FreshnessInput, now: number): boolean {
  if (input.temporality !== 'decaying') return false
  return effectiveConfidence(input, now) < AGED_CONFIDENCE_BELOW
}
