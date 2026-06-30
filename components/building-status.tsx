'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

type RunStatus = {
  status: 'none' | 'running' | 'done' | 'error'
  summary?: { passes?: unknown[] } | null
  error?: string | null
}

// The mine-status surface shown after a capture or after onboarding. It triggers
// the miner once (trigger='onboarding') and polls until the run is done, so the
// user watches their graph build instead of landing on an empty app.
//
// `onboarding` re-frames the copy ("Building your initial context") and, on
// completion, routes the brand-new user straight into the now-populated app.
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
      if (j?.status === 'done' || j?.status === 'error') setRun(j as RunStatus)
    } catch {
      // network blip; polling continues
    }
  }, [])

  // Fire the run exactly once on mount.
  useEffect(() => {
    if (triggeredRef.current) return
    triggeredRef.current = true
    void trigger()
  }, [trigger])

  // Poll status until the run is done.
  useEffect(() => {
    let active = true
    const tick = async () => {
      try {
        const res = await fetch('/api/miner/status', { cache: 'no-store' })
        if (!res.ok) return
        const j = (await res.json()) as RunStatus
        if (active && (j.status === 'running' || j.status === 'done' || j.status === 'error' || j.status === 'none')) {
          setRun(j)
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

  if (run.status === 'error') {
    return (
      <div style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
        <p className="mp-bad" style={{ margin: 0 }}>
          {onboarding ? 'We hit a snag building your initial context.' : 'We hit a snag building your memory.'}
        </p>
        {run.error ? <p className="mp-meta" style={{ margin: 0 }}>{run.error}</p> : null}
        <button type="button" className="mp-btn mp-btn--primary" onClick={retry}>
          Try again
        </button>
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
          : 'Building your memory from your conversation. This can take a few minutes.'}
      </p>
      {onboarding ? null : (
        <p className="mp-meta" style={{ margin: 0, textAlign: 'center' }}>
          You can leave this page; it keeps building. Come back any time to check.
        </p>
      )}
      <Link href="/" className="mp-link" style={{ fontSize: 14 }}>Skip ahead to the app &rarr;</Link>
    </div>
  )
}
