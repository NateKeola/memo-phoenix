import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'

// The durable observability writer. One helper every subsystem calls at its status
// and error boundaries, persisted to observability_events (migration 0018). This is
// what makes a failure on another device or user visible after the fact, where
// "works on my laptop" hides it. Fire-and-forget: never throws into the caller.
//
// PRIVACY (enforced here): NEVER pass user content (transcripts, capture bodies) or
// secrets. Only status, error type/message, timings, and metadata (counts, ids,
// flags). Error messages are truncated. meta is expected to be shaped values, not
// free text; callers must not put content in it.

export type ObsSubsystem =
  | 'auth'
  | 'capture_text'
  | 'capture_memo'
  | 'scribe'
  | 'interview'
  | 'onboarding'
  | 'miner'
  | 'cron'
  | 'surface'
  | 'api'

export type ObsLevel = 'info' | 'warn' | 'error'

export type ObsEvent = {
  subsystem: ObsSubsystem
  event: string
  level?: ObsLevel
  status?: string | null
  userId?: string | null
  durationMs?: number | null
  errorType?: string | null
  errorMessage?: string | null
  meta?: Record<string, unknown>
}

export async function logObs(e: ObsEvent): Promise<void> {
  try {
    const admin = createAdminClient()
    const level: ObsLevel = e.level ?? (e.errorMessage || e.errorType ? 'error' : 'info')
    const { error } = await admin.from('observability_events').insert({
      user_id: e.userId ?? null,
      subsystem: e.subsystem,
      event: e.event,
      level,
      status: e.status ?? null,
      duration_ms: typeof e.durationMs === 'number' ? Math.round(e.durationMs) : null,
      error_type: e.errorType ? String(e.errorType).slice(0, 120) : null,
      error_message: e.errorMessage ? String(e.errorMessage).slice(0, 500) : null,
      meta: e.meta ?? {},
    })
    if (error) console.error('[obs] insert failed:', error.message)
  } catch (err) {
    console.error('[obs] logObs threw:', err instanceof Error ? err.message : String(err))
  }
}

// Turn any caught value into {type, message} without leaking content. Use at catch
// boundaries so an error is recorded uniformly.
export function obsError(err: unknown): { errorType: string; errorMessage: string } {
  if (err instanceof Error) return { errorType: err.name || 'Error', errorMessage: err.message }
  return { errorType: 'unknown', errorMessage: String(err) }
}

// ---- console reads (service-role; call ONLY from an operator-gated context) ----

export type ObsRow = {
  id: string
  user_id: string | null
  subsystem: string
  event: string
  level: string
  status: string | null
  duration_ms: number | null
  error_type: string | null
  error_message: string | null
  meta: Record<string, unknown>
  created_at: string
}

// Recent observability events across all users (the operator monitors the whole
// beta). Service-role read: the CALLER must have already verified isOperator.
export async function readRecentObs(limit = 150): Promise<ObsRow[]> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('observability_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`[obs] read: ${error.message}`)
  return (data ?? []) as ObsRow[]
}

export type SubsystemHealth = {
  subsystem: string
  lastEventAt: string | null
  errorsLastHour: number
  lastError: { message: string | null; at: string } | null
  healthy: boolean
}

// Per-subsystem health rolled up from the recent rows: healthy unless there is an
// error in the last hour. Pure over the rows passed in (no extra query).
export function rollUpHealth(rows: ObsRow[], nowMs: number): SubsystemHealth[] {
  const bySub = new Map<string, ObsRow[]>()
  for (const r of rows) {
    const arr = bySub.get(r.subsystem) ?? []
    arr.push(r)
    bySub.set(r.subsystem, arr)
  }
  const hourAgo = nowMs - 60 * 60 * 1000
  const out: SubsystemHealth[] = []
  for (const [subsystem, arr] of bySub) {
    const errs = arr.filter((r) => r.level === 'error')
    const recentErrs = errs.filter((r) => new Date(r.created_at).getTime() >= hourAgo)
    const lastErr = errs[0] // rows are newest-first
    out.push({
      subsystem,
      lastEventAt: arr[0]?.created_at ?? null,
      errorsLastHour: recentErrs.length,
      lastError: lastErr ? { message: lastErr.error_message, at: lastErr.created_at } : null,
      healthy: recentErrs.length === 0,
    })
  }
  return out.sort((a, b) => a.subsystem.localeCompare(b.subsystem))
}
