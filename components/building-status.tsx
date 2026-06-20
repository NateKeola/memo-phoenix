'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'

type RunStatus = {
  status: 'none' | 'running' | 'done' | 'error'
  summary?: { passes?: unknown[] } | null
  error?: string | null
}

// "Building your memory" surface. After onboarding, a new user sees this instead of
// an empty app: it triggers the miner once (off the local machine, via the Pro run
// route or the Action) and polls the run status until the graph is built.
export function BuildingStatus() {
  const [run, setRun] = useState<RunStatus>({ status: 'none' })
  const triggeredRef = useRef(false)

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

  const retry = useCallback(() => {
    setRun({ status: 'none' })
    triggeredRef.current = true
    void trigger()
  }, [trigger])

  if (run.status === 'done') {
    return (
      <div style={{ display: 'grid', gap: 12, maxWidth: 460 }}>
        <p style={{ color: 'green' }}>Your memory is ready.</p>
        <p>
          <Link href="/">Enter Memo &rarr;</Link>
        </p>
      </div>
    )
  }

  if (run.status === 'error') {
    return (
      <div style={{ display: 'grid', gap: 12, maxWidth: 460 }}>
        <p style={{ color: 'crimson' }}>We hit a snag building your memory.</p>
        {run.error ? <p style={{ color: '#888', fontSize: 13 }}>{run.error}</p> : null}
        <div>
          <button type="button" onClick={retry}>
            Try again
          </button>
        </div>
        <p>
          <Link href="/">Go to the app anyway &rarr;</Link>
        </p>
      </div>
    )
  }

  // 'none' (starting) or 'running'
  return (
    <div style={{ display: 'grid', gap: 12, maxWidth: 460 }}>
      <p>Building your memory from your conversation. This can take a few minutes.</p>
      <p style={{ color: '#888', fontSize: 13 }}>
        You can leave this page; it keeps building. Come back any time to check.
      </p>
      <p>
        <Link href="/">Skip ahead to the app &rarr;</Link>
      </p>
    </div>
  )
}
