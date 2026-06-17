// Runtime configuration for the miner. All values are read lazily from the
// worker env so importing the package never requires secrets.

export const MODEL = process.env.MINER_MODEL || 'claude-opus-4-8'

// Effort tunes thinking depth + token spend (low | medium | high | xhigh | max).
export const EFFORT = process.env.MINER_EFFORT || 'high'

// Adaptive thinking is on by default. With thinking OFF, Opus 4.8 can leak
// reasoning into the response text and break JSON parsing, so keep it on unless
// explicitly disabled.
export const THINKING_ON = process.env.MINER_THINKING !== 'off'

export const MAX_TOKENS = Number(process.env.MINER_MAX_TOKENS) || 16000

// Pagination: cap items emitted per LLM call so a large set is never truncated.
export function pageLimit(): number {
  const n = Number(process.env.MINER_PAGE_SIZE)
  return Number.isFinite(n) && n > 0 ? n : 200
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
