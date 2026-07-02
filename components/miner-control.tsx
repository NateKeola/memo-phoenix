'use client'

import { useCallback, useEffect, useState } from 'react'
import type { MinerState, LedgerRun } from '@/lib/miner/state'
import { BrandSeed } from '@/components/brand-seed'

const TRIGGER_LABEL: Record<string, string> = {
  manual: 'manual',
  auto: 'auto',
  onboarding: 'onboarding',
  cli: 'CLI',
  action: 'action',
}

function relative(iso: string): string {
  const then = new Date(iso).getTime()
  const s = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

// The miner-control surface. Reuses the B2 runtime (the /api/miner/run route, the
// miner_runs ledger, the concurrency guard); this is the UI over it: a manual "run
// now", live progress while a run is in flight, a run ledger, and a
// progress-toward-auto-run bar. It also fires the auto-run when the measure has
// crossed the threshold (server re-checks the threshold, and the lock prevents a
// double-run, so this is safe).
export function MinerControl() {
  const [state, setState] = useState<MinerState | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/miner/state', { cache: 'no-store' })
      if (!res.ok) return
      setState((await res.json()) as MinerState)
    } catch {
      // transient; the next poll retries
    }
  }, [])

  const run = useCallback(
    async (trigger: 'manual' | 'auto') => {
      setBusy(true)
      if (trigger === 'manual') setNote('Starting a run...')
      // refresh right away so the active row shows as soon as the lock is taken
      void fetchState()
      try {
        const res = await fetch('/api/miner/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ trigger }),
        })
        const j = (await res.json().catch(() => ({}))) as { status?: string; error?: string; hint?: string }
        if (j.status === 'already_running') setNote('A run is already in progress.')
        else if (j.status === 'skipped') setNote('')
        else if (j.status === 'dispatched') setNote('Run started off-machine. It will appear below shortly.')
        else if (j.status === 'needs_offload')
          setNote(j.hint ?? 'This update is too large to run inside the app; the off-machine runner is not configured.')
        else if (j.status === 'done') setNote('Run complete.')
        else if (j.status === 'error') setNote(`Run failed: ${j.error ?? 'unknown error'}`)
        else setNote('')
      } catch (e) {
        setNote(`Could not start a run: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setBusy(false)
        void fetchState()
      }
    },
    [fetchState]
  )

  // initial load
  useEffect(() => {
    void fetchState()
  }, [fetchState])

  // poll while a run is active so live status and the ledger refresh
  useEffect(() => {
    if (!state?.active) return
    const id = setInterval(() => void fetchState(), 4000)
    return () => clearInterval(id)
  }, [state?.active, fetchState])

  if (!state) return <p className="mp-sub">Loading...</p>

  const pct = Math.min(100, Math.round((state.newCaptures / Math.max(1, state.threshold)) * 100))
  const active = state.active

  return (
    <div style={{ display: 'grid', gap: 22, marginTop: 18 }}>
      {/* current status + run now */}
      <section className="mp-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <BrandSeed size={56} mark={22} />
          <div style={{ flex: 1, minWidth: 0 }}>
            {active ? (
              <>
                <div className="mp-row__title" style={{ fontSize: 17 }}>Updating your memory...</div>
                <div className="mp-meta" style={{ marginTop: 4 }}>
                  started {relative(active.started_at)}, {TRIGGER_LABEL[active.trigger] ?? active.trigger}
                  {active.stage ? ` \u00b7 working on ${active.stage}` : ''}
                </div>
              </>
            ) : (
              <div className="mp-row__title" style={{ fontSize: 17 }}>
                {state.ledger[0]
                  ? `Last updated ${relative(state.ledger[0].started_at)}.`
                  : 'Your memory has not been built yet.'}
              </div>
            )}
          </div>
        </div>
        <button
          type="button"
          className="mp-btn mp-btn--primary mp-btn--block"
          style={{ marginTop: 16 }}
          onClick={() => run('manual')}
          disabled={busy || Boolean(active)}
        >
          {active ? 'Running...' : 'Run now'}
        </button>
        {active ? (
          <p className="mp-meta" style={{ marginTop: 10 }}>A full update can take a few minutes. This page updates as it runs.</p>
        ) : null}
        {note ? <p className="mp-meta" style={{ marginTop: 10 }}>{note}</p> : null}
      </section>

      {/* progress toward the next daily auto-mine */}
      <section>
        <p className="mp-sub" style={{ margin: '0 0 8px', fontSize: 14 }}>
          {state.newCaptures} new {state.newCaptures === 1 ? 'note' : 'notes'} since the last update. Memo
          updates once a day when there are at least {state.threshold}, or run it now.
        </p>
        {state.pendingCorrections > 0 ? (
          <p className="mp-meta" style={{ margin: '0 0 8px' }}>
            {state.pendingCorrections} {state.pendingCorrections === 1 ? 'correction is' : 'corrections are'} waiting
            to apply; the next update will fold {state.pendingCorrections === 1 ? 'it' : 'them'} in.
          </p>
        ) : null}
        <div className="mp-progress">
          <div className={`mp-progress__fill${state.shouldAutoRun ? ' mp-progress__fill--ready' : ''}`} style={{ width: `${pct}%` }} />
        </div>
      </section>

      {/* run ledger */}
      <section>
        <p className="mp-eyebrow">Recent runs</p>
        {state.ledger.length === 0 ? (
          <p className="mp-meta" style={{ marginTop: 10 }}>No runs yet.</p>
        ) : (
          <ul className="mp-list" style={{ marginTop: 6 }}>
            {state.ledger.map((r) => (
              <li key={r.id} className="mp-row">
                <LedgerLine run={r} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function LedgerLine({ run }: { run: LedgerRun }) {
  const when = new Date(run.started_at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  const trigger = TRIGGER_LABEL[run.trigger] ?? run.trigger
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', width: '100%' }}>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span style={{ fontSize: 16, color: 'var(--txt)' }}>{when}</span>
        <span style={{ alignSelf: 'flex-start', fontSize: 11, letterSpacing: '0.06em', background: 'var(--surf-2)', color: 'var(--txt-faint)', padding: '4px 8px', borderRadius: 6 }}>{trigger}</span>
      </span>
      <span style={{ textAlign: 'right', fontSize: 14, color: statusColor(run.status) }}>
        {run.status === 'running' ? `in progress${run.stage ? ` (${run.stage})` : ''}` : null}
        {run.status === 'stalled'
          ? `stopped responding${run.stage ? ` in ${run.stage}` : ''}; will be cleaned up automatically`
          : null}
        {run.status === 'error' ? `failed${run.error ? `: ${run.error.slice(0, 80)}` : ''}` : null}
        {run.status === 'done'
          ? run.changes
            ? `added ${run.changes.inserted}, updated ${run.changes.updated}, unchanged ${run.changes.unchanged}`
            : 'complete'
          : null}
      </span>
    </div>
  )
}

function statusColor(s: string): string {
  if (s === 'done') return 'var(--ok)'
  if (s === 'error' || s === 'stalled') return 'var(--record-soft)'
  return 'var(--accent-deep)'
}
