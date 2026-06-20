'use client'

import { useCallback, useEffect, useState } from 'react'
import type { MinerState, LedgerRun } from '@/lib/miner/state'

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
        const j = (await res.json().catch(() => ({}))) as { status?: string; error?: string }
        if (j.status === 'already_running') setNote('A run is already in progress.')
        else if (j.status === 'skipped') setNote('')
        else if (j.status === 'dispatched') setNote('Run started off-machine. It will appear below shortly.')
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

  if (!state) return <p>Loading...</p>

  const pct = Math.min(100, Math.round((state.newCaptures / Math.max(1, state.threshold)) * 100))
  const active = state.active

  return (
    <div style={{ display: 'grid', gap: 20, maxWidth: 620 }}>
      {/* current status + run now */}
      <section>
        {active ? (
          <div style={{ background: '#fdf6e3', padding: 12, borderRadius: 8 }}>
            <p style={{ margin: 0 }}>
              <strong>Updating your memory...</strong> (started {relative(active.started_at)},{' '}
              {TRIGGER_LABEL[active.trigger] ?? active.trigger})
            </p>
            <p style={{ margin: '6px 0 0', color: '#888', fontSize: 13 }}>
              A full update can take a few minutes. This page updates as it runs.
            </p>
          </div>
        ) : (
          <p style={{ margin: 0 }}>
            {state.ledger[0]
              ? `Last updated ${relative(state.ledger[0].started_at)}.`
              : 'Your memory has not been built yet.'}
          </p>
        )}
        <div style={{ marginTop: 10 }}>
          <button type="button" onClick={() => run('manual')} disabled={busy || Boolean(active)}>
            {active ? 'Running...' : 'Run now'}
          </button>
        </div>
        {note ? <p style={{ marginTop: 8, color: '#555', fontSize: 14 }}>{note}</p> : null}
      </section>

      {/* progress toward the next daily auto-mine */}
      <section>
        <p style={{ margin: '0 0 6px', fontSize: 14 }}>
          {state.newCaptures} new {state.newCaptures === 1 ? 'note' : 'notes'} since the last update. Memo
          updates once a day when there are at least {state.threshold}, or run it now.
        </p>
        <div style={{ background: '#eee', borderRadius: 6, height: 12, overflow: 'hidden' }}>
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              background: state.shouldAutoRun ? '#b8860b' : '#cbb26a',
              transition: 'width 200ms',
            }}
          />
        </div>
      </section>

      {/* run ledger */}
      <section>
        <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>Recent runs</h2>
        {state.ledger.length === 0 ? (
          <p style={{ color: '#888' }}>No runs yet.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {state.ledger.map((r) => (
              <li key={r.id} style={{ borderBottom: '1px solid #eee', paddingBottom: 8 }}>
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
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 14 }}>
      <span>
        <span style={{ color: '#888' }}>{when}</span>{' '}
        <span style={{ fontSize: 12, background: '#f0ead6', padding: '1px 6px', borderRadius: 10 }}>{trigger}</span>
      </span>
      <span style={{ textAlign: 'right', color: statusColor(run.status) }}>
        {run.status === 'running' ? 'in progress' : null}
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
  if (s === 'done') return '#2e7d32'
  if (s === 'error') return 'crimson'
  return '#b8860b'
}
