import { randomUUID } from 'node:crypto'
import { normalizeLabel } from './identity'

// Stable-identity resolution (deterministic-id hardening).
//
// Identity is decoupled from the mutable label. An incoming extracted entity is
// resolved to an EXISTING stable id through a deterministic, conservative ladder:
//   1. exact   - same normalized label as a current canonical row
//   2. alias   - the normalized label (or an emitted alias) is a known alias of a
//                current row (persisted entity_aliases or corrections), or one of
//                the incoming aliases names a current row
//   3. fuzzy   - best token-Jaccard candidate above a threshold, with an optional
//                context key (e.g. a commitment's linked person) that relaxes the
//                bar when it agrees and is a hard NO when it disagrees
//   4. mint    - nothing matched: a NEW random id (never derived from the label)
//
// Bias: too-tight (a missed match) is no worse than today (today always mints a new
// id on drift); too-loose (merging two distinct entities) is a regression, so the
// fuzzy tier is conservative and guards against ambiguous merges. A label change
// records a new alias; it never changes the id.

export type ResolveCandidate = {
  id: string
  label: string | null
  aliases: string[]
  // optional disambiguator (commitments pass the linked person id); when both the
  // incoming entity and a candidate carry one, agreement relaxes fuzzy and
  // disagreement excludes the candidate outright.
  contextKey?: string | null
}

export type ResolveVia = 'exact' | 'alias' | 'fuzzy' | 'mint'

// Defaults are env-tunable but conservative. The person-corroborated threshold
// mirrors the proven companion-overlay re-match (0.5 with person, 0.8 without).
export const STRICT_FUZZY = clampNum(process.env.MINER_RESOLVE_FUZZY, 0.8)
export const CONTEXT_FUZZY = clampNum(process.env.MINER_RESOLVE_FUZZY_CTX, 0.5)
const AMBIGUITY_MARGIN = 0.1

function clampNum(v: string | undefined, dflt: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : dflt
}

export function tokens(s: string | null | undefined): Set<string> {
  const out = new Set<string>()
  if (!s) return out
  for (const t of normalizeLabel(s).split(/[^a-z0-9]+/)) if (t) out.add(t)
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const uni = a.size + b.size - inter
  return uni === 0 ? 0 : inter / uni
}

// The pure resolution decision. Returns the matched stable id (and how), or null to
// signal "mint a new id". No I/O, no randomness, fully unit-testable.
export function resolveId(input: {
  labelNorm: string
  aliasNorms: string[]
  contextKey?: string | null
  candidates: ResolveCandidate[]
  aliasMap: Map<string, string> // alias_norm -> stable id (persisted aliases + corrections)
  strictFuzzy?: number
  contextFuzzy?: number
}): { id: string | null; via: ResolveVia } {
  const { labelNorm, aliasNorms, aliasMap } = input
  const strict = input.strictFuzzy ?? STRICT_FUZZY
  const ctxThresh = input.contextFuzzy ?? CONTEXT_FUZZY
  const ctx = input.contextKey ? String(input.contextKey) : null

  // Context-key hard filter, applied to EVERY tier: a candidate whose context
  // disagrees is never the same entity, regardless of label. Two commitments with
  // identical text but different linked people are different commitments, so a
  // disagreeing person must block even an exact label match. A candidate with no
  // context (unknown) stays eligible.
  const candidates = input.candidates.filter((c) => {
    const cCtx = c.contextKey ? String(c.contextKey) : null
    return !(ctx && cCtx && ctx !== cCtx)
  })

  const candidateIds = new Set(candidates.map((c) => c.id))
  const aliasOf = (c: ResolveCandidate) => c.aliases.map(normalizeLabel).filter(Boolean)

  // 1. exact: same normalized label as a current row
  for (const c of candidates) {
    if (c.label && normalizeLabel(c.label) === labelNorm) return { id: c.id, via: 'exact' }
  }

  // 2a. alias map: the label is a known alias of a CURRENT row (do not resurrect a
  //     superseded/absent id, so require the mapped id to be a current candidate)
  const mapped = aliasMap.get(labelNorm)
  if (mapped && candidateIds.has(mapped)) return { id: mapped, via: 'alias' }
  // 2b. the label is in a candidate's own alias list
  for (const c of candidates) {
    if (aliasOf(c).includes(labelNorm)) return { id: c.id, via: 'alias' }
  }
  // 2c. an emitted alias names a current row (by its label, its aliases, or the map)
  for (const an of aliasNorms) {
    const m = aliasMap.get(an)
    if (m && candidateIds.has(m)) return { id: m, via: 'alias' }
    for (const c of candidates) {
      if ((c.label && normalizeLabel(c.label) === an) || aliasOf(c).includes(an)) return { id: c.id, via: 'alias' }
    }
  }

  // 3. fuzzy: best token-Jaccard candidate above threshold; ambiguity-guarded.
  const labelToks = tokens(labelNorm)
  const scored: Array<{ c: ResolveCandidate; score: number; thresh: number }> = []
  for (const c of candidates) {
    const cCtx = c.contextKey ? String(c.contextKey) : null
    if (ctx && cCtx && ctx !== cCtx) continue // disagreeing context is a hard no
    const bothCtx = Boolean(ctx && cCtx && ctx === cCtx)
    let best = jaccard(labelToks, tokens(c.label))
    for (const a of c.aliases) best = Math.max(best, jaccard(labelToks, tokens(a)))
    scored.push({ c, score: best, thresh: bothCtx ? ctxThresh : strict })
  }
  const passing = scored.filter((s) => s.score >= s.thresh).sort((a, b) => b.score - a.score)
  if (passing.length > 0) {
    // ambiguity guard: if the top two are near-tied, do not merge (too risky)
    if (passing.length === 1 || passing[0].score - passing[1].score >= AMBIGUITY_MARGIN) {
      return { id: passing[0].c.id, via: 'fuzzy' }
    }
  }

  return { id: null, via: 'mint' }
}

// Stateful resolver used by the miner. Wraps resolveId with id minting and alias
// accumulation. Minted entities join the candidate pool so two mentions of the same
// new thing in one run collapse onto one id.
export class Resolver {
  private candidates: ResolveCandidate[]
  private aliasMap: Map<string, string>
  private mintFn: () => string
  private added = new Map<string, string>() // alias_norm -> stable id (new, to persist)
  private strict?: number
  private ctxThresh?: number

  constructor(opts: {
    candidates: ResolveCandidate[]
    aliasMap?: Map<string, string>
    mint?: () => string
    strictFuzzy?: number
    contextFuzzy?: number
  }) {
    this.candidates = opts.candidates.map((c) => ({ ...c }))
    this.aliasMap = new Map(opts.aliasMap ?? [])
    this.mintFn = opts.mint ?? (() => randomUUID())
    this.strict = opts.strictFuzzy
    this.ctxThresh = opts.contextFuzzy
  }

  resolve(
    label: string,
    aliases: string[] = [],
    contextKey?: string | null
  ): { id: string; via: ResolveVia; isNew: boolean } {
    const labelNorm = normalizeLabel(label)
    const aliasNorms = aliases.map((a) => normalizeLabel(a)).filter(Boolean)
    const r = resolveId({
      labelNorm,
      aliasNorms,
      contextKey,
      candidates: this.candidates,
      aliasMap: this.aliasMap,
      strictFuzzy: this.strict,
      contextFuzzy: this.ctxThresh,
    })
    let id: string
    let isNew = false
    if (r.id) {
      id = r.id
    } else {
      id = this.mintFn()
      isNew = true
      // join the pool so a re-mention this run collapses onto the same id
      this.candidates.push({ id, label, aliases, contextKey })
    }
    this.remember(labelNorm, id)
    for (const an of aliasNorms) this.remember(an, id)
    return { id, via: r.via, isNew }
  }

  private remember(aliasNorm: string, id: string): void {
    if (!aliasNorm) return
    if (this.aliasMap.get(aliasNorm) === id) return
    this.aliasMap.set(aliasNorm, id)
    this.added.set(aliasNorm, id)
  }

  // New (alias_norm -> stable id) pairs discovered this run, to persist to
  // entity_aliases so future runs remember a drifted label.
  newAliases(): Array<{ alias_norm: string; stable_id: string }> {
    return Array.from(this.added, ([alias_norm, stable_id]) => ({ alias_norm, stable_id }))
  }
}
