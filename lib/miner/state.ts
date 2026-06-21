import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

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
  passes?: Array<{ inserted?: number; updated?: number; unchanged?: number; skipped?: boolean }>
}

export type LedgerRun = {
  id: string
  status: 'running' | 'done' | 'error'
  trigger: string
  runtime: string | null
  started_at: string
  ended_at: string | null
  error: string | null
  changes: RunChanges | null
  captures: number | null
  extracted: number | null
}

export type MinerState = {
  active: { id: string; trigger: string; started_at: string } | null
  newCaptures: number
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

function toLedgerRow(r: Record<string, unknown>): LedgerRun {
  const summary = (r.summary ?? null) as MineSummaryShape | null
  return {
    id: String(r.id),
    status: r.status as LedgerRun['status'],
    trigger: String(r.trigger ?? 'manual'),
    runtime: (r.runtime as string | null) ?? null,
    started_at: String(r.started_at),
    ended_at: (r.ended_at as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    changes: summarizeChanges(summary),
    captures: typeof summary?.captures === 'number' ? summary.captures : null,
    extracted: typeof summary?.extracted === 'number' ? summary.extracted : null,
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
      .select('id, status, trigger, runtime, started_at, ended_at, summary, error')
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
  const rows = (runs ?? []) as Record<string, unknown>[]
  const activeRow = rows.find((r) => r.status === 'running') ?? null
  const watermark = (lastDone?.started_at as string | undefined) ?? null

  // Count captures created since that watermark (RLS-scoped + explicit user filter).
  let q = supabase.from('captures').select('id', { count: 'exact', head: true }).eq('user_id', userId)
  if (watermark) q = q.gt('created_at', watermark)
  const { count } = await q
  const newCaptures = count ?? 0

  const shouldAutoRun = !activeRow && newCaptures >= AUTO_RUN_NEW_CAPTURES

  return {
    active: activeRow
      ? {
          id: String(activeRow.id),
          trigger: String(activeRow.trigger ?? 'manual'),
          started_at: String(activeRow.started_at),
        }
      : null,
    newCaptures,
    threshold: AUTO_RUN_NEW_CAPTURES,
    shouldAutoRun,
    lastSuccessfulAt: watermark,
    ledger: rows.map(toLedgerRow),
  }
}
