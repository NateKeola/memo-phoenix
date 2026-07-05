'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

// Live-ish refresh for the observability console: re-runs the server component
// (re-reads the durable layer) on an interval, so recent status stays current
// without a full reload. A toggle lets the operator pause it while reading.
export function ObsRefresh({ intervalMs = 8000 }: { intervalMs?: number }) {
  const router = useRouter()
  const [live, setLive] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!live) return
    const id = setInterval(() => {
      router.refresh()
      setTick((t) => t + 1)
    }, intervalMs)
    return () => clearInterval(id)
  }, [live, intervalMs, router])

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
      <button
        type="button"
        className="mp-btn mp-btn--ghost"
        style={{ padding: '5px 11px', fontSize: 13 }}
        onClick={() => {
          router.refresh()
          setTick((t) => t + 1)
        }}
      >
        Refresh
      </button>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--txt-muted)', cursor: 'pointer' }}>
        <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
        Live ({Math.round(intervalMs / 1000)}s){live ? ` · ${tick}` : ''}
      </label>
    </div>
  )
}
