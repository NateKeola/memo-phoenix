import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isRunStale } from '@memo/miner-core'

// --- Auto-run threshold (Open-Exploratory: a default is chosen, easy to change) ---
//
// MEASURE: the number of NEW captures created since the last successful mine. When
// it reaches AUTO_RUN_NEW_CAPTURES, an automatic mine is triggered through the same
// /api/miner/run route + concurrency guard, recorded with trigger='auto'.
//
// This governs BACKGROUND re-mining during normal app use only. It does NOT gate
// the onboarding mine (which runs at trigger='onboarding', always, the moment the
// first conversation lands) and has nothing to do with onboarding interview length.
//
// Options considered (see the PR write-up for tradeoffs); pick by editing this one
// constant (or the MINER_AUTORUN_NEW_CAPTURES env override):
//   A. new-capture count  [CHOSEN DEFAULT = 10]  most transparent: a capture is the
//      unit the user actually creates, so "3 of 5 new notes" is legible to them.
//   B. new raw-row count: finer-grained, but raw rows are a miner internal, so the
//      progress bar would count something the user never sees.
//   C. time since last run: a cron-like backstop; catches slow drips but mines even
//      when nothing changed (wasteful) and needs a scheduler to fire headlessly.
//   D. a combination (e.g. >=N new captures OR >=T hours with >=1 new capture).
// To change the value: edit the constant below (or set MINER_AUTORUN_NEW_CAPTURES).
export const AUTO_RUN_NEW_CAPTURES = Number(process.env.MINER_AUTORUN_NEW_CAPTURES) || 10

export type RunChanges = { inserted: number; updated: number; unchanged: number }

type MineSummaryShape = {
  captures?: number
  extracted?: number
  rawInserted?: number
  durationMs?: number
  // the derivation path (full/incremental/noop) and how many captures were folded,
  // so the Memory-screen ledger can show the run mode (mirrors the observability chip).
  // A failed run carries only { mode } (stamped early by mineWithLock).
  mode?: string
  newCaptures?: number
  passes?: Array<{
    table?: string
    inserted?: number
    updated?: number
    unchanged?: number
    skipped?: boolean
    // A-1 retirement signal, written per pass since Phase 1 of the miner cost fix.
    // Absent on older runs and on passes that never attempted retirement.
    retirement?: { outcome?: string; current?: number; qualified?: number; cap?: number; retired?: number }
  }>
}

// Per-run rollup of the A-1 retirement signal, for the Memory-screen ledger.
// "empty" (attempted against a table with no current rows) is deliberately
// distinct from "nothing qualified" (attempted against a live table): the enum
// has no empty member, current: 0 inside none_qualified is the load-bearing
// distinction (decision in docs/miner-cost-fix-plan.md 4.1).
export type RefusedRetirement = { table: string; qualified: number; cap: number; current: number }
export type RetirementRollup = {
  retired: number // rows retired across all passes
  refused: RefusedRetirement[] // cap_refused passes, each with its counts
  nothingQualified: number // passes attempted with current rows and zero qualified
  empty: number // passes attempted against a table with no current rows
  off: number // passes reporting the env kill switch
  notAttempted: number // passes that never called retirement (memo-skipped)
}

// Null when NO pass carries a retirement object (pre-Phase-1 runs), so old
// ledger rows render exactly as before.
export function summarizeRetirement(summary: MineSummaryShape | null | undefined): RetirementRollup | null {
  if (!summary || !Array.isArray(summary.passes)) return null
  if (!summary.passes.some((p) => p.retirement)) return null
  const roll: RetirementRollup = { retired: 0, refused: [], nothingQualified: 0, empty: 0, off: 0, notAttempted: 0 }
  for (const p of summary.passes) {
    const r = p.retirement
    if (!r) {
      roll.notAttempted++
      continue
    }
    roll.retired += r.retired || 0
    if (r.outcome === 'cap_refused') {
      roll.refused.push({
        table: p.table ?? 'unknown',
        qualified: r.qualified || 0,
        cap: r.cap || 0,
        current: r.current || 0,
      })
    } else if (r.outcome === 'disabled') {
      roll.off++
    } else if (r.outcome === 'none_qualified') {
      if ((r.current || 0) === 0) roll.empty++
      else roll.nothingQualified++
    }
  }
  return roll
}

export type LedgerRun = {
  id: string
  // 'stalled' is a DERIVED state: the row says running but its heartbeat has been
  // silent past the staleness threshold, i.e. the process was killed (typically a
  // serverless timeout). The next run start reclaims it; readers show it honestly
  // instead of an endless "in progress".
  status: 'running' | 'done' | 'error' | 'stalled'
  trigger: string
  runtime: string | null
  started_at: string
  ended_at: string | null
  error: string | null
  stage: string | null
  changes: RunChanges | null
  captures: number | null
  extracted: number | null
  // 'full' | 'incremental' | 'noop' | null (null for pre-mode-recording runs)
  mode: string | null
  newCaptures: number | null
  // null for runs that predate the retirement signal
  retirement: RetirementRollup | null
}

export type MinerState = {
  active: { id: string; trigger: string; started_at: string; stage: string | null } | null
  newCaptures: number
  // corrections (renames/merges) filed since the last successful mine. They are
  // explicit user actions awaiting application and force the FULL derivation path,
  // so they count as pending work for the auto-run decision (previously they
  // triggered nothing and sat unapplied indefinitely).
  pendingCorrections: number
  threshold: number
  shouldAutoRun: boolean
  lastSuccessfulAt: string | null
  ledger: LedgerRun[]
}

// Sums the inserted/updated/unchanged the miner already reports per canonical pass,
// so the ledger shows "what changed" without re-deriving anything.
export function summarizeChanges(summary: MineSummaryShape | null | undefined): RunChanges | null {
  if (!summary || !Array.isArray(summary.passes)) return null
  return summary.passes.reduce<RunChanges>(
    (acc, p) => ({
      inserted: acc.inserted + (p.inserted || 0),
      updated: acc.updated + (p.updated || 0),
      unchanged: acc.unchanged + (p.unchanged || 0),
    }),
    { inserted: 0, updated: 0, unchanged: 0 }
  )
}

function toLedgerRow(r: Record<string, unknown>, nowMs: number): LedgerRun {
  const summary = (r.summary ?? null) as MineSummaryShape | null
  const rawStatus = r.status as 'running' | 'done' | 'error'
  const status: LedgerRun['status'] =
    rawStatus === 'running' &&
    isRunStale({ started_at: String(r.started_at), heartbeat_at: (r.heartbeat_at as string | null) ?? null }, nowMs)
      ? 'stalled'
      : rawStatus
  return {
    id: String(r.id),
    status,
    trigger: String(r.trigger ?? 'manual'),
    runtime: (r.runtime as string | null) ?? null,
    started_at: String(r.started_at),
    ended_at: (r.ended_at as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    stage: (r.stage as string | null) ?? null,
    changes: summarizeChanges(summary),
    captures: typeof summary?.captures === 'number' ? summary.captures : null,
    extracted: typeof summary?.extracted === 'number' ? summary.extracted : null,
    mode: typeof summary?.mode === 'string' ? summary.mode : null,
    newCaptures: typeof summary?.newCaptures === 'number' ? summary.newCaptures : null,
    retirement: summarizeRetirement(summary),
  }
}

// Reads the user's miner state via the RLS-scoped client. The app only ever READS
// miner_runs/captures (the miner is the sole writer, invariant 4); this computes
// the "new context since the last successful mine" measure that drives the
// progress bar and the auto-run decision.
export async function getMinerState(
  supabase: SupabaseClient,
  userId: string,
  ledgerLimit = 20
): Promise<MinerState> {
  // The ledger (newest first; the active run is always the newest row) and the
  // watermark (the last SUCCESSFUL run's start, queried directly so a long tail of
  // failed runs cannot hide it) are independent, so fetch them in parallel.
  const [{ data: runs }, { data: lastDone }] = await Promise.all([
    supabase
      .from('miner_runs')
      .select('id, status, trigger, runtime, started_at, ended_at, summary, error, heartbeat_at, stage')
      .eq('user_id', userId)
      .order('started_at', { ascending: false })
      .limit(ledgerLimit),
    supabase
      .from('miner_runs')
      .select('started_at')
      .eq('user_id', userId)
      .eq('status', 'done')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  const nowMs = Date.now()
  const rows = (runs ?? []) as Record<string, unknown>[]
  // A run counts as ACTIVE only while it is alive (recent heartbeat). A stalled
  // zombie must NOT suppress the auto-run measure or the daily cron: that exact
  // suppression kept background mining off for hours in production. The zombie row
  // itself is reclaimed by the next mineWithLock.
  const activeRow =
    rows.find(
      (r) =>
        r.status === 'running' &&
        !isRunStale(
          { started_at: String(r.started_at), heartbeat_at: (r.heartbeat_at as string | null) ?? null },
          nowMs
        )
    ) ?? null
  const watermark = (lastDone?.started_at as string | undefined) ?? null

  // Pending work since the watermark: new captures AND corrections filed after the
  // last successful mine (both RLS-scoped + explicit user filter, in parallel).
  let capQ = supabase.from('captures').select('id', { count: 'exact', head: true }).eq('user_id', userId)
  if (watermark) capQ = capQ.gt('created_at', watermark)
  let corrQ = supabase.from('corrections').select('id', { count: 'exact', head: true }).eq('user_id', userId)
  if (watermark) corrQ = corrQ.gt('created_at', watermark)
  const [{ count: capCount }, { count: corrCount }] = await Promise.all([capQ, corrQ])
  const newCaptures = capCount ?? 0
  const pendingCorrections = corrCount ?? 0

  // Auto-run when the capture measure crosses the threshold, OR when any correction
  // is pending: a correction is an explicit user action (a rename/merge they expect
  // to apply) and never accumulates toward a capture count, so without this clause
  // it would wait indefinitely for unrelated captures to pile up.
  const shouldAutoRun = !activeRow && (newCaptures >= AUTO_RUN_NEW_CAPTURES || pendingCorrections > 0)

  return {
    active: activeRow
      ? {
          id: String(activeRow.id),
          trigger: String(activeRow.trigger ?? 'manual'),
          started_at: String(activeRow.started_at),
          stage: (activeRow.stage as string | null) ?? null,
        }
      : null,
    newCaptures,
    pendingCorrections,
    threshold: AUTO_RUN_NEW_CAPTURES,
    shouldAutoRun,
    lastSuccessfulAt: watermark,
    ledger: rows.map((r) => toLedgerRow(r, nowMs)),
  }
}
