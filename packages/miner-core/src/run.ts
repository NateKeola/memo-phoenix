import { admin } from './supabase'
import { extractCapture, type Capture } from './extract'
import { runDerivation } from './derive'
import { INCREMENTAL, runIncrementalDerivation, type IncrementalMode } from './incremental'
import { readExcludedCaptureIds } from './stage-common'
import { logEvent } from './telemetry'
import { addUsage, emptyUsage, type PassResult, type Usage } from './types'

export type MineSummary = {
  captures: number
  extracted: number
  rawInserted: number
  passes: PassResult[]
  extractUsage: Usage
  durationMs: number
  // Which derivation path ran and how many captures were folded, so the miner_runs
  // summary (and the observability console) can show whether a routine mine was full
  // or incremental. Non-incremental runs are always 'full'.
  mode: IncrementalMode
  newCaptures: number
}

// Full recompute for one user: extract every not-yet-extracted capture into the
// raw layer, then derive the canonical layer (A -> B -> C) from the full raw set.
// Extraction and each derivation pass are memoized on input hashes, so a second
// run over unchanged input does no LLM work and writes nothing.
// The miner runs with the service-role key, which BYPASSES RLS, so per-user
// isolation is enforced entirely by every query filtering on this user_id. A
// missing or malformed user_id must therefore be a HARD FAILURE, never a fall-back
// to a global/unscoped run: an empty value would silently scope to nothing (or, if
// a filter were ever dropped, to everyone). We refuse loudly instead. The id is an
// auth.users uuid.
const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function assertUserId(userId: string, where: string): void {
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId.trim())) {
    throw new Error(
      `[miner] ${where}: a valid user_id is required (got ${JSON.stringify(userId)}); refusing to run unscoped`
    )
  }
}

// Mid-run visibility: mine() reports the stage it is entering through this
// callback (wired to the miner_runs heartbeat by mineWithLock). Optional so the
// CLI/tests can call mine() bare; failures inside the callback are swallowed by
// the caller (a heartbeat must never kill a run).
export type StageReporter = (stage: string) => Promise<void>

export async function mine(
  userId: string,
  startedAtMs: number,
  onStage?: StageReporter
): Promise<MineSummary> {
  assertUserId(userId, 'mine')
  const stage = async (s: string) => {
    if (onStage) await onStage(s)
  }
  const { data, error } = await admin()
    .from('captures')
    .select('id, user_id, mode, modality, body, target_kind, target_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`[miner] read captures: ${error.message}`)
  // Retracted captures (capture_exclusions) are skipped entirely: never extracted,
  // never derived from. Their existing traces are cleaned by the full recompute.
  const excluded = await readExcludedCaptureIds(userId)
  const captures = ((data ?? []) as Capture[]).filter((c) => !excluded.has(c.id))

  let extractUsage = emptyUsage()
  let rawInserted = 0
  let extracted = 0
  let capIndex = 0
  for (const cap of captures) {
    capIndex++
    await stage(`extract ${capIndex}/${captures.length}`)
    const r = await extractCapture(cap)
    extractUsage = addUsage(extractUsage, r.usage)
    rawInserted += r.rawInserted
    if (!r.skipped) extracted++
  }

  // Default (MINER_INCREMENTAL unset): the full recompute, byte-for-byte unchanged.
  // ON: fold in only the not-yet-incorporated captures (the full recompute is still
  // used for the baseline and for corrections; see incremental.ts).
  let passes: PassResult[]
  let mode: IncrementalMode
  let newCaptures: number
  if (INCREMENTAL) {
    const r = await runIncrementalDerivation(userId, onStage)
    passes = r.passes
    mode = r.mode
    newCaptures = r.newCaptures
  } else {
    passes = await runDerivation(userId, onStage)
    mode = 'full'
    newCaptures = captures.length
  }
  await stage('finishing')

  const summary: MineSummary = {
    captures: captures.length,
    extracted,
    rawInserted,
    passes,
    extractUsage,
    durationMs: 0,
    mode,
    newCaptures,
  }

  // run-level telemetry; durationMs is stamped by the caller's clock
  const totalUsage = passes.reduce((acc, p) => addUsage(acc, p.usage), extractUsage)
  await logEvent({
    user_id: userId,
    event_type: 'miner_run',
    name: 'mine:complete',
    attrs: {
      stage: 'all',
      captures: captures.length,
      extracted,
      raw_inserted: rawInserted,
      tokens_in: totalUsage.input_tokens,
      tokens_out: totalUsage.output_tokens,
      cache_read: totalUsage.cache_read_input_tokens,
      cache_creation: totalUsage.cache_creation_input_tokens,
    },
  })

  return summary
}

export type MineRunResult =
  | { status: 'done'; runId: string; summary: MineSummary }
  | { status: 'error'; runId: string; error: string }
  | { status: 'already_running' }

// A crashed run (a serverless function hard-killed at the timeout, say) leaves a
// 'running' row that never reaches 'done'. Staleness keys on the HEARTBEAT (the
// miner beats at every capture-extraction and pass boundary), falling back to
// started_at for pre-heartbeat rows: a run silent this long is dead. This both
// resolves zombies quickly and protects a legitimately LONG run (the old
// started_at-only threshold of 20 minutes was shorter than a real 22-minute full
// recompute, so a concurrent trigger could reclaim a LIVE run mid-flight).
export const STALE_RUN_MS = Number(process.env.MINER_STALE_RUN_MS) || 10 * 60 * 1000

// Is a 'running' row dead? Shared by the lock reclaim here and (via re-export) the
// app's status/state readers, so "stalled" means the same thing everywhere.
export function isRunStale(row: { started_at: string; heartbeat_at?: string | null }, nowMs: number): boolean {
  const last = row.heartbeat_at ?? row.started_at
  return nowMs - new Date(last).getTime() > STALE_RUN_MS
}

// The concurrency guard. Wraps mine() in a miner_runs row that doubles as the lock
// (the partial unique index allows at most one status='running' per user), the
// audit trail, and the status the "building your memory" UI polls. Both the Vercel
// run route and the CLI (local or GitHub Action) go through this, so two runs for
// the same user can never collide regardless of which runtime triggered them.
export async function mineWithLock(
  userId: string,
  opts: { trigger: string; runtime: string }
): Promise<MineRunResult> {
  assertUserId(userId, 'mineWithLock')
  const db = admin()

  // Reclaim a stale run before trying to acquire. Staleness is heartbeat-based
  // (isRunStale): a beating run keeps its lock however long it takes; a silent one
  // is closed with an honest error instead of hanging as a zombie.
  let { data: active, error: activeErr } = await db
    .from('miner_runs')
    .select('id, started_at, heartbeat_at, stage')
    .eq('user_id', userId)
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (activeErr) {
    // Pre-0017 DB (heartbeat columns absent): fall back to the legacy shape so a
    // genuine zombie can still be reclaimed (started_at staleness) instead of
    // blocking every future run behind already_running.
    const legacy = await db
      .from('miner_runs')
      .select('id, started_at')
      .eq('user_id', userId)
      .eq('status', 'running')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    active = legacy.data as typeof active
  }
  if (active) {
    if (!isRunStale(active as { started_at: string; heartbeat_at?: string | null }, Date.now())) {
      return { status: 'already_running' }
    }
    const deadStage = (active as { stage?: string | null }).stage
    await db
      .from('miner_runs')
      .update({
        status: 'error',
        error: `stalled and reclaimed (no heartbeat for over ${Math.round(STALE_RUN_MS / 60000)} min${deadStage ? `; died in: ${deadStage}` : ''}; likely killed by a runtime timeout)`,
        ended_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('id', active.id)
      .eq('status', 'running')
  }

  const { data: runRow, error: lockErr } = await db
    .from('miner_runs')
    .insert({ user_id: userId, status: 'running', trigger: opts.trigger, runtime: opts.runtime })
    .select('id')
    .single()
  if (lockErr) {
    const code = (lockErr as { code?: string }).code
    // 23505 = the partial unique index fired => a concurrent run already holds it.
    if (code === '23505') return { status: 'already_running' }
    // Table missing (DB not yet migrated): degrade to an unlocked mine so the CLI
    // still works, matching the project's graceful-degradation pattern.
    if (code === '42P01' || code === 'PGRST205') {
      const started = Date.now()
      const summary = await mine(userId, started)
      summary.durationMs = Date.now() - started
      return { status: 'done', runId: '(unlocked)', summary }
    }
    throw new Error(`[miner] could not acquire run lock: ${lockErr.message}`)
  }
  const runId = (runRow as { id: string }).id

  // The heartbeat: stamp heartbeat_at + stage at every boundary mine() reports.
  // Best-effort (a heartbeat failure must never kill the run) and cheap (~one
  // small UPDATE per pass). Readers derive the run's EFFECTIVE state from it.
  const beat: StageReporter = async (stageName) => {
    try {
      await db
        .from('miner_runs')
        .update({ heartbeat_at: new Date().toISOString(), stage: stageName })
        .eq('user_id', userId)
        .eq('id', runId)
        .eq('status', 'running')
    } catch (e) {
      console.warn('[miner] heartbeat failed (continuing):', e instanceof Error ? e.message : e)
    }
  }
  await beat('starting')

  const started = Date.now()
  try {
    const summary = await mine(userId, started, beat)
    summary.durationMs = Date.now() - started
    await db
      .from('miner_runs')
      .update({ status: 'done', summary, ended_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('id', runId)
    return { status: 'done', runId, summary }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await db
      .from('miner_runs')
      .update({ status: 'error', error: msg.slice(0, 1000), ended_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('id', runId)
    return { status: 'error', runId, error: msg }
  }
}
