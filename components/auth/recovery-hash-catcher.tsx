'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

// Catches an implicit-flow RECOVERY link whose session arrived as URL fragment
// tokens (#access_token=...&type=recovery). Fragments never reach the server and
// survive the middleware's redirects, so a recovery link that landed at the app
// root ends up here (on /login) with the tokens still in the hash. We hand them to
// /api/auth/recovery-session (which sets validated session cookies) and continue
// to /reset-password. Renders a small notice only while actually bridging.
export function RecoveryHashCatcher() {
  const router = useRouter()
  const [bridging, setBridging] = useState(false)
  const firedRef = useRef(false)

  useEffect(() => {
    if (firedRef.current) return
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash
    if (!hash) return
    const params = new URLSearchParams(hash)
    const accessToken = params.get('access_token')
    const refreshToken = params.get('refresh_token')
    const type = params.get('type')
    if (!accessToken || !refreshToken || type !== 'recovery') return
    firedRef.current = true
    setBridging(true)
    // clear the tokens from the visible URL immediately
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    void (async () => {
      try {
        const res = await fetch('/api/auth/recovery-session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }),
        })
        if (res.ok) {
          router.replace('/reset-password')
          return
        }
      } catch {
        // fall through to the expired state
      }
      router.replace('/reset-password?error=expired')
    })()
  }, [router])

  if (!bridging) return null
  return (
    <p className="mp-meta mp-rise" style={{ textAlign: 'center', marginBottom: 14 }}>
      Opening your password reset...
    </p>
  )
}
