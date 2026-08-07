import { randomInt } from 'node:crypto'

// ---- short claim handles ----------------------------------------------------
//
// Raw claim ids are 36-character uuids. Every paged pass serializes the whole
// claim list into EVERY batch, and asks the model to reproduce those uuids
// verbatim in `source_claim_ids`. That is 43,272 characters of opaque identifier
// across one full recompute, and one wrong character fails the batch: the
// 2026-08-07 people pass died four times out of five calls with the model
// splicing the first eight characters of the correct id onto the tail of a
// different real claim.
//
// So the payload carries a SHORT RANDOM HANDLE instead, translated back to the
// real uuid the instant the response is parsed. Handles exist only between
// buildUser and the parsed response: nothing persists a handle, the canonical
// graph stores real uuids exactly as before, and `inputHash` is computed from
// the real uuids (not the rendered message), so memoization is unaffected.
//
// WHY RANDOM AND NOT ORDINAL. c1..c184 would be shorter still, but if the model
// writes c18 meaning c17 that handle EXISTS, translation succeeds, validation
// passes, and the provenance is silently wrong. The only reason today's failure
// is catchable at all is that a spliced uuid lands on nothing. Randomly issuing
// 184 handles out of 32^4 = 1,048,576 keeps that property: a slipped character
// lands on an unissued handle ~99.98% of the time and fails loudly, in the same
// shape as today's "cited unknown raw id".
//
// The alphabet drops `l`, `o`, `0` and `1` as visually confusable, which is the
// whole point of the exercise.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789' // 32 chars
const HANDLE_LEN = 4

export type ClaimHandles = {
  // uuid -> handle, for rendering the payload
  handleFor(claimId: string): string
  // handle -> uuid, or null when the handle was not issued in this pass. Policy
  // (throw vs drop) lives in translateClaimHandles, not here.
  claimFor(handle: string): string | null
  readonly size: number
}

function mint(): string {
  let out = ''
  for (let i = 0; i < HANDLE_LEN; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

// Issue one handle per claim id, ONCE PER PASS (not per batch), so all batches
// and all three retry attempts of a batch see byte-identical text.
export function issueHandles(claimIds: Iterable<string>): ClaimHandles {
  const toHandle = new Map<string, string>()
  const toClaim = new Map<string, string>()
  for (const id of claimIds) {
    if (toHandle.has(id)) continue
    let h = mint()
    // Collision is vanishingly unlikely at these sizes but must be deterministic
    // rather than probabilistic: two claims sharing a handle would merge their
    // provenance silently, which is the exact failure mode this scheme exists to
    // rule out.
    while (toClaim.has(h)) h = mint()
    toHandle.set(id, h)
    toClaim.set(h, id)
  }
  return {
    handleFor: (id) => toHandle.get(id) ?? id,
    // Case-folded: the alphabet is lowercase-only, so an uppercase character can
    // only be a case slip, and folding it is injective over the issued set. It
    // cannot make a wrong handle resolve to a real claim.
    claimFor: (h) => toClaim.get(String(h).trim().toLowerCase()) ?? null,
    get size() {
      return toHandle.size
    },
  }
}

// Fields whose contents are raw claim ids and MUST resolve. A miss here is a
// hard error, matching what validateCited does for an unknown uuid today.
const STRICT_FIELDS = ['source_claim_ids', 'supporting_claim_ids']

function translateStrict(v: unknown, handles: ClaimHandles, ctx: string): unknown {
  if (!Array.isArray(v)) return v
  return v.map((x) => {
    // Non-strings are left exactly as they are: uniqueStrings drops them
    // downstream today and must keep doing so, so this cannot change behaviour.
    if (typeof x !== 'string') return x
    const real = handles.claimFor(x)
    if (real === null) {
      // Same wording as validateCited, deliberately: call-telemetry classifies on
      // /cited unknown raw id/ and would otherwise lose the error class. A handle
      // is an opaque random token carrying no content, so it is shaped output and
      // safe in miner_runs.error under the standing rule, exactly as a uuid is.
      throw new Error(
        `[miner] ${ctx}: cited unknown raw id ${x} (provenance must reference real claims)`
      )
    }
    return real
  })
}

// DELIBERATELY LENIENT, do not "fix" this asymmetry without its own PR.
//
// `discrepancies[].claim_ids` and `open_threads[].source_claim_id` are tolerated
// loosely TODAY: a hallucinated uuid in either flows straight through and simply
// matches nothing downstream (parseDiscrepancy needs 2+ ids, planSupersessions
// needs 2+ distinct rows, and an open thread's id is only ever counted). Nothing
// validates them and nothing throws.
//
// Dropping an unmapped handle reproduces that outcome exactly. Throwing instead
// would add a hard-failure path where none exists and change retry behaviour,
// which this PR is explicitly scoped not to do. Tightening these is a separate
// decision with its own PR.
function translateLenient(v: unknown, handles: ClaimHandles): unknown {
  if (!Array.isArray(v)) return v
  const out: unknown[] = []
  for (const x of v) {
    if (typeof x !== 'string') continue
    const real = handles.claimFor(x)
    if (real !== null) out.push(real)
  }
  return out
}

// Translate every handle in a parsed model response back to its real claim uuid,
// in place, BEFORE validation runs. validateCited is untouched and still sees
// real uuids checked against the real `known` set.
//
// Field-name-specific, never blanket, because the payload carries TWO id spaces:
// `edges[].source_id` / `target_id` and `insights[].affected_entity_ids` are
// CANONICAL NODE uuids, not claim ids, and are stored directly. Translating them
// would corrupt the graph.
export function translateClaimHandles(
  parsed: Record<string, unknown>,
  handles: ClaimHandles,
  itemsField: 'nodes' | 'edges' | 'insights',
  ctx: string
): void {
  const items = parsed[itemsField]
  if (Array.isArray(items)) {
    for (const it of items) {
      if (!it || typeof it !== 'object') continue
      const item = it as Record<string, unknown>
      for (const f of STRICT_FIELDS) {
        if (f in item) item[f] = translateStrict(item[f], handles, ctx)
      }
    }
  }

  if (Array.isArray(parsed.discrepancies)) {
    for (const d of parsed.discrepancies) {
      if (!d || typeof d !== 'object') continue
      const disc = d as Record<string, unknown>
      if ('claim_ids' in disc) disc.claim_ids = translateLenient(disc.claim_ids, handles)
    }
  }

  if (Array.isArray(parsed.open_threads)) {
    for (const t of parsed.open_threads) {
      if (!t || typeof t !== 'object') continue
      const thread = t as Record<string, unknown>
      const v = thread.source_claim_id
      // null is the documented "no relevant claim" answer and stays null.
      if (typeof v === 'string') thread.source_claim_id = handles.claimFor(v)
    }
  }
}
