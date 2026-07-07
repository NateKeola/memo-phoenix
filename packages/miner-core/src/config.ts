// Runtime configuration for the miner. All values are read lazily from the
// worker env so importing the package never requires secrets.

export const MODEL = process.env.MINER_MODEL || 'claude-opus-4-8'

// Effort tunes thinking depth + token spend (low | medium | high | xhigh | max).
export const EFFORT = process.env.MINER_EFFORT || 'high'

// Adaptive thinking is on by default. With thinking OFF, Opus 4.8 can leak
// reasoning into the response text and break JSON parsing, so keep it on unless
// explicitly disabled.
export const THINKING_ON = process.env.MINER_THINKING !== 'off'

// Output ceiling per LLM call. This is a CEILING, not a target: the model stops at
// end_turn when done, so raising it does not increase normal output, it only removes
// the truncation cliff. `callClaude` (anthropic.ts) STREAMS now (messages.stream ->
// finalMessage), which removed the SDK's non-streaming >10-minute refusal (that
// refusal fires for a NON-streaming request once max_tokens exceeds ~21,333), so the
// old reason to hold this at 24000 no longer applies. With adaptive thinking ON
// (EFFORT below) thinking shares this budget with the emitted JSON, and on the large
// verbose canonical_people pass (~70 people) high-effort thinking alone consumed the
// entire 24000 budget before ANY text was emitted -> "model returned no text
// (stop_reason=max_tokens)", so the forced-FULL recompute that corrections require
// never completed. 40000 gives headroom for deep thinking PLUS a page of verbose
// people nodes; it is a CEILING so it is free for normal batches (they stop at
// end_turn well below it) and only removes the cliff for the pathological case. Opus
// 4.8 allows up to 128k output so 40000 is well within, and streaming has no upfront
// timeout. Env-tunable (MINER_MAX_TOKENS).
export const MAX_TOKENS = Number(process.env.MINER_MAX_TOKENS) || 40000

// Pagination: cap items emitted per LLM call so a large set is never truncated. This
// is the primary anti-truncation lever: a smaller page bounds each call's output (and
// the reasoning depth of that sub-task) so thinking + the batch fit under MAX_TOKENS
// with room to spare, and the pass simply paginates for larger sets. Default 40.
//
// The VERBOSE phrase-heavy node types page SMALLER: a canonical_people node carries a
// 1-3 sentence summary, an aliases array, a rich free-form data object, and a FULL
// source_claim_ids array that (after merges) lists every contributing claim, so a page
// of 40 people plus high-effort thinking blew past the ceiling; facts and insights are
// similarly verbose. They page at MINER_VERBOSE_PAGE_SIZE (default 15) so a single page
// always fits alongside thinking, while the lighter types keep the larger page.
const VERBOSE_TABLES = new Set(['canonical_people', 'canonical_facts', 'insights'])
export function pageLimit(table?: string): number {
  const g = Number(process.env.MINER_PAGE_SIZE)
  const base = Number.isFinite(g) && g > 0 ? g : 40
  if (table && VERBOSE_TABLES.has(table)) {
    const v = Number(process.env.MINER_VERBOSE_PAGE_SIZE)
    return Number.isFinite(v) && v > 0 ? v : Math.min(base, 15)
  }
  return base
}

export const MAX_BATCHES = 40
export const MAX_BATCH_ATTEMPTS = 3

export function requireEnv(): { url: string; serviceRoleKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) throw new Error('[miner] NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) is not set')
  if (!serviceRoleKey) throw new Error('[miner] SUPABASE_SERVICE_ROLE_KEY is not set')
  return { url, serviceRoleKey }
}

// The single user this corpus belongs to. Resolved once, from env, since this is
// a single-user system. (The miner uses the service-role client, which has no
// auth.uid(), so user_id is stamped explicitly on every row.)
export function requireUserId(): string {
  const id = process.env.MEMO_USER_ID
  if (!id) {
    throw new Error(
      '[miner] MEMO_USER_ID is not set. Set it to the single user id (the auth.users id for the one account).'
    )
  }
  return id
}
