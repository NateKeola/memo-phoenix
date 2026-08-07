// Per-model-call telemetry: ONE shaped row per call, on success and on failure.
//
// WHY. Before this, the miner's only telemetry was `record()` in runDerivation, which
// fires after a pass COMPLETES. The 2026-08-07 run died in batch 2 of its first pass,
// so it wrote zero telemetry rows and was invisible in the admin console; the single
// surviving artifact was the miner_runs row. Any run that dies inside its first pass
// had the same blind spot, which is exactly the class of failure that has been
// recurring since 2026-07-06.
//
// PRIVACY (invariant 11). Every value emitted here is an id, a count, a duration, or a
// fixed enum. The model's response text is NEVER included: it summarizes real people,
// so it is user content. It goes to stdout only (anthropic.ts dumpModelOutput).
// `reportLlmCall` filters through LLM_CALL_ATTR_KEYS, so an attribute that is not on
// that list cannot reach the table even if a caller passes it. The security harness
// (scripts/check-obs-db.mjs) asserts this shape against live rows.
//
// This module is instrumentation only. Nothing in the miner branches on its output.

import { logEvent } from './telemetry'
import type { LlmMeta } from './anthropic'

export const LLM_CALL_EVENT_TYPE = 'llm_call'

// The COMPLETE set of attribute keys an llm_call row may carry. Adding a key here is a
// deliberate act that has to be justified against invariant 11, and the harness will
// flag any key that shows up in a live row without being listed.
export const LLM_CALL_ATTR_KEYS = [
  // which call this was
  'pass',
  'ctx',
  'batch',
  'attempt',
  'attempts_allowed',
  // what it was asked to do
  'batch_limit',
  'claims_sent',
  'already_emitted_sent',
  'user_chars',
  // what came back
  'stop_reason',
  'text_chars',
  'block_count',
  'block_types',
  'items_returned',
  // cost and time
  'tokens_in',
  'tokens_out',
  'tokens_thinking',
  'cache_read',
  'cache_write',
  'duration_ms',
  // how it ended
  'outcome',
  'error_class',
  'rejected_claim_id',
] as const

// Where in the call the failure happened. Set by the caller as it advances, so the
// classification is structural rather than inferred after the fact.
export type LlmCallPhase = 'call' | 'parse' | 'validate'

export type LlmCallOutcome = 'ok' | 'error'

export type LlmErrorClass =
  | 'no_text'
  | 'api_error'
  | 'invalid_json'
  | 'non_object_json'
  | 'unknown_claim_id'
  | 'empty_source_claim_ids'
  | 'validation_error'
  | 'unknown'

// A fixed enum, derived from the phase plus a coarse shape match on the thrown
// message. The message itself is never stored.
export function classifyLlmError(phase: LlmCallPhase, err: unknown): LlmErrorClass {
  const m = err instanceof Error ? err.message : String(err)
  if (phase === 'call') return /model returned no text/.test(m) ? 'no_text' : 'api_error'
  if (phase === 'parse') {
    if (/did not return valid JSON/.test(m)) return 'invalid_json'
    if (/non-object JSON value/.test(m)) return 'non_object_json'
    return 'unknown'
  }
  if (/cited unknown raw id/.test(m)) return 'unknown_claim_id'
  if (/empty source_claim_ids|empty supporting_claim_ids/.test(m)) return 'empty_source_claim_ids'
  return 'validation_error'
}

// The rejected id from a provenance failure. A uuid IS an id, which is shaped and
// allowed, and it is the single most useful field for recognizing a transcription
// splice (2026-08-07: the head came from the right claim, the tail from another).
export function rejectedClaimId(err: unknown): string | null {
  const m = err instanceof Error ? err.message : String(err)
  const hit = m.match(/cited unknown raw id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  return hit ? hit[1] : null
}

// Best-effort stop_reason for the call-phase failure, where there is no LlmMeta to
// read because callClaude threw before returning one.
export function stopReasonFrom(err: unknown): string | null {
  const m = err instanceof Error ? err.message : String(err)
  const hit = m.match(/stop_reason=([a-z_]+)/i)
  return hit ? hit[1] : null
}

// Flatten an LlmMeta into the shaped attribute names used on the row.
export function usageAttrs(meta: LlmMeta): Record<string, unknown> {
  return {
    stop_reason: meta.stop_reason,
    text_chars: meta.text_chars,
    block_count: meta.block_count,
    block_types: meta.block_types,
    tokens_in: meta.input_tokens,
    tokens_out: meta.output_tokens,
    tokens_thinking: meta.thinking_tokens,
    cache_read: meta.cache_read_input_tokens,
    cache_write: meta.cache_creation_input_tokens,
  }
}

// Write the row. logEvent already swallows its own errors and never throws into the
// caller. We AWAIT it deliberately: the failures this exists to record are exactly the
// ones that kill the process on the next line, and a fire-and-forget insert would not
// survive that.
export async function reportLlmCall(userId: string, attrs: Record<string, unknown>): Promise<void> {
  const shaped: Record<string, unknown> = {}
  for (const key of LLM_CALL_ATTR_KEYS) {
    const value = attrs[key]
    if (value !== undefined && value !== null) shaped[key] = value
  }
  await logEvent({
    user_id: userId,
    event_type: LLM_CALL_EVENT_TYPE,
    name: typeof attrs.pass === 'string' ? attrs.pass : 'unknown',
    duration_ms: typeof attrs.duration_ms === 'number' ? attrs.duration_ms : undefined,
    attrs: shaped,
  })
}
