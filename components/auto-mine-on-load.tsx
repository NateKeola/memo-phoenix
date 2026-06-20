'use client'

import { useEffect, useRef } from 'react'

// Silent auto-run trigger on app load. Checks the "new context since last mine"
// measure and, if it has crossed the threshold, kicks off an auto mine. The server
// re-checks the threshold and the concurrency lock prevents a double-run, so firing
// this from multiple surfaces (home + the miner page) is safe. Renders nothing.
//
// This makes the auto-run actually automatic on app use. For a fully headless
// trigger (no open tab), set MINER_USE_GITHUB_ACTION=1 so /api/miner/run dispatches
// the run to the GitHub Action instead of running it inline.
export function AutoMineOnLoad() {
  const firedRef = useRef(false)
  useEffect(() => {
    if (firedRef.current) return
    firedRef.current = true
    ;(async () => {
      try {
        const res = await fetch('/api/miner/state', { cache: 'no-store' })
        if (!res.ok) return
        const s = (await res.json()) as { shouldAutoRun?: boolean }
        if (!s.shouldAutoRun) return
        await fetch('/api/miner/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ trigger: 'auto' }),
        })
      } catch {
        // best effort; the miner page is the reliable auto-run + progress surface
      }
    })()
  }, [])
  return null
}
