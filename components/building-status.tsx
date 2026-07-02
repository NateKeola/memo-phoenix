'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

type RunStatus = {
  status: 'none' | 'running' | 'done' | 'error' | 'stalled' | 'dispatched' | 'needs_offload'
  summary?: { passes?: unknown[] } | null
  error?: string | null
  stage?: string | null
  hint?: string
}

// The mine-status surface shown after onboarding (and as a passive progress view).
//
// ONBOARDING (`onboarding` true): triggers the first mine once and polls until it
// is done, so a brand-new user watches their initial context build and lands in a
// populated app.
//
// GENERAL VIEW (`onboarding` false): VIEW-ONLY. It never starts a mine (a bare
// visit to /building used to silently fire an inline full recompute that a
// serverless timeout killed into a zombie, observed live); it just reports the
// latest run, including the honest 'stalled' state when a run died.
export function BuildingStatus({ onboarding = false }: { onboarding?: boolean }) {
  const router = useRouter()
  const [run, setRun] = useState<RunStatus>({ status: 'none' })
  const triggeredRef = useRef(false)
  const redirectedRef = useRef(false)

  const trigger = useCallback(async () => {
    try {
      const res = await fetch('/api/miner/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trigger: 'onboarding' }),
      })
      const j = (await res.json().catch(() => ({}))) as RunStatus & { status?: string }
      // The inline run resolves here when it finishes (or immediately if dispatched
      // / already running). Polling below is the source of truth for display.
      if (j?.status === 'done' || j?.status === 'error' || j?.status === 'needs_offload') setRun(j as RunStatus)
    } catch {
      // network blip; polling continues
    }
  }, [])

  // Fire the run exactly once on mount, ONBOARDING ONLY.
  useEffect(() => {
    if (!onboarding || triggeredRef.current) return
    triggeredRef.current = true
    void trigger()
  }, [onboarding, trigger])

  // Poll status until the run is done.
  useEffect(() => {
    let active = true
    const tick = async () => {
      try {
        const res = await fetch('/api/miner/status', { cache: 'no-store' })
        if (!res.ok) return
        const j = (await res.json()) as RunStatus
        if (active && ['running', 'done', 'error', 'none', 'stalled'].includes(j.status)) {
          // A needs_offload verdict lives only in client state (no run row is
          // created), so a poll that reports a STALE prior run must not overwrite
          // it; only a genuinely live run supersedes the verdict.
          setRun((prev) => (prev.status === 'needs_offload' && j.status !== 'running' ? prev : j))
        }
      } catch {
        // ignore a transient failure
      }
    }
    void tick()
    const id = setInterval(() => {
      if (run.status === 'done') return
      void tick()
    }, 3000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [run.status])

  // Onboarding: once the initial mine is done, drop the new user straight into the
  // populated app (after a brief "ready" beat).
  useEffect(() => {
    if (!onboarding || run.status !== 'done' || redirectedRef.current) return
    redirectedRef.current = true
    const t = setTimeout(() => router.push('/'), 1500)
    return () => clearTimeout(t)
  }, [onboarding, run.status, router])

  const retry = useCallback(() => {
    setRun({ status: 'none' })
    triggeredRef.current = true
    void trigger()
  }, [trigger])

  if (run.status === 'done') {
    return (
      <div className="mp-rise" style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
        <p className="mp-ok" style={{ margin: 0 }}>
          {onboarding ? 'Your memory is ready. Taking you in...' : 'Your memory is ready.'}
        </p>
        <Link href="/" className="mp-btn mp-btn--primary">Enter Memo</Link>
      </div>
    )
  }

  if (run.status === 'stalled') {
    return (
      <div style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
        <p className="mp-bad" style={{ margin: 0, textAlign: 'center' }}>
          That update stopped responding{run.stage ? ` (while working on ${run.stage})` : ''} and was
          most likely cut off. It will be cleaned up automatically.
        </p>
        {onboarding ? (
          <button type="button" className="mp-btn mp-btn--primary" onClick={retry}>
            Try again
          </button>
        ) : (
          <p className="mp-meta" style={{ margin: 0 }}>Start a fresh update from the Memory page.</p>
        )}
        <Link href="/" className="mp-link" style={{ fontSize: 14 }}>Go to the app &rarr;</Link>
      </div>
    )
  }

  if (run.status === 'needs_offload') {
    return (
      <div style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
        <p className="mp-bad" style={{ margin: 0, textAlign: 'center' }}>
          This update is too large to run inside the app.
        </p>
        {run.hint ? <p className="mp-meta" style={{ margin: 0, textAlign: 'center', maxWidth: 380 }}>{run.hint}</p> : null}
        <Link href="/" className="mp-link" style={{ fontSize: 14 }}>Go to the app &rarr;</Link>
      </div>
    )
  }

  if (run.status === 'error') {
    return (
      <div style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
        <p className="mp-bad" style={{ margin: 0 }}>
          {onboarding ? 'We hit a snag building your initial context.' : 'We hit a snag building your memory.'}
        </p>
        {run.error ? <p className="mp-meta" style={{ margin: 0 }}>{run.error}</p> : null}
        {onboarding ? (
          <button type="button" className="mp-btn mp-btn--primary" onClick={retry}>
            Try again
          </button>
        ) : null}
        <Link href="/" className="mp-link" style={{ fontSize: 14 }}>Go to the app anyway &rarr;</Link>
      </div>
    )
  }

  // 'none' (starting) or 'running'
  return (
    <div style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
      <p className="mp-sub" style={{ margin: 0, textAlign: 'center', maxWidth: 360 }}>
        {onboarding
          ? 'Memo is building your initial context from your first conversation. This will only take a moment.'
          : run.status === 'running'
            ? 'Building your memory from your conversation. This can take a few minutes.'
            : 'No update is running right now.'}
      </p>
      {run.status === 'running' && run.stage ? (
        <p className="mp-meta" style={{ margin: 0 }}>Working on: {run.stage}</p>
      ) : null}
      {onboarding ? null : run.status === 'running' ? (
        <p className="mp-meta" style={{ margin: 0, textAlign: 'center' }}>
          You can leave this page; it keeps building. Come back any time to check.
        </p>
      ) : (
        <p className="mp-meta" style={{ margin: 0, textAlign: 'center' }}>
          Start one from the Memory page if you want to fold in your latest notes.
        </p>
      )}
      <Link href="/" className="mp-link" style={{ fontSize: 14 }}>
        {run.status === 'running' ? 'Skip ahead to the app \u2192' : 'Back to the app \u2192'}
      </Link>
    </div>
  )
}
