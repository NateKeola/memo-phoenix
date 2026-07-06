'use client'

import { usePathname } from 'next/navigation'
import { CaptureMenu } from '@/components/capture-menu'
import { BottomNav } from '@/components/bottom-nav'

// The shared app chrome: the always-reachable capture FAB + the bottom nav, rendered
// ONCE in the root layout so every app screen has them (the FAB used to be on Home
// only, so capturing meant navigating back). Hidden on the focused auth / onboarding
// flows and the capture routes themselves, where chrome would intrude. On a person's
// profile the FAB is context-aware: it tags the capture with that person.
const HIDE_PREFIXES = [
  '/login',
  '/onboarding',
  '/building',
  '/not-authorized',
  '/reset-password',
  '/forgot-password',
  '/auth',
  '/capture',
]

export function AppChrome() {
  const pathname = usePathname() || '/'
  if (HIDE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) return null

  // A person's profile is /people/<id> (a single segment, not the list or a sub-route).
  // The FAB tags captures with that person; only the id is needed, the miner resolves
  // the name from it at extraction.
  const match = pathname.match(/^\/people\/([^/]+)$/)
  const personId = match ? match[1] : undefined

  return (
    <>
      <CaptureMenu personId={personId} />
      <BottomNav />
    </>
  )
}
