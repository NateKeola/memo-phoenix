import { requireAllowedUser } from '@/lib/auth/guard'
import { getToday } from '@/lib/companion/today'
import { logEvent } from '@/lib/telemetry'
import { CompanionView } from '@/components/companion/companion-view'
import { PageHeader } from '@/components/page-header'
import { BottomNav } from '@/components/bottom-nav'

export const dynamic = 'force-dynamic'

// The companion follow-ups surface. Deterministic selection (no model); the only
// model calls are the on-demand brainstorm conversations. It suggests reaching out
// in real life and never sends anything.
export default async function CompanionPage() {
  const { supabase, user } = await requireAllowedUser()

  const today = await getToday({ supabase, userId: user.id }, Date.now())

  // Fire-and-forget: do NOT block the render on a telemetry insert round-trip.
  // logEvent catches its own errors and never throws, so this is safe to not await.
  void logEvent({ user_id: user.id, event_type: 'companion_surfaced', attrs: { ...today.counts } })

  return (
    <main className="mp-page">
      <PageHeader back="/" backLabel="Home" />
      <h1 className="mp-h1">Today</h1>
      <p className="mp-sub">
        Things and people in your life worth tending. Memo can think a follow-up through with you, but
        it never reaches out for you. The next step is yours to take.
      </p>
      <div style={{ marginTop: 18 }}>
        <CompanionView today={today} />
      </div>
      <BottomNav />
    </main>
  )
}
