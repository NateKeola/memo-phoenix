import Link from 'next/link'
import { requireAllowedUser } from '@/lib/auth/guard'
import { getToday } from '@/lib/companion/today'
import { logEvent } from '@/lib/telemetry'
import { CompanionView } from '@/components/companion/companion-view'

export const dynamic = 'force-dynamic'

// The companion follow-ups surface. Deterministic selection (no model); the only
// model calls are the on-demand brainstorm conversations. It suggests reaching out
// in real life and never sends anything.
export default async function CompanionPage() {
  const { supabase, user } = await requireAllowedUser()

  const today = await getToday({ supabase, userId: user.id }, Date.now())

  await logEvent({ user_id: user.id, event_type: 'companion_surfaced', attrs: { ...today.counts } })

  return (
    <main
      style={{
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 760,
        background: '#faf6ec',
        minHeight: '100vh',
        color: '#2c2a25',
      }}
    >
      <p>
        <Link href="/" style={{ color: '#b07a14' }}>
          &larr; Home
        </Link>
      </p>
      <h1 style={{ marginBottom: 4 }}>Follow-ups</h1>
      <p style={{ color: '#6f6a5f' }}>
        Things and people in your life worth tending. Memo can think a follow-up through with you, but
        it never reaches out for you. The next step is yours to take.
      </p>
      <CompanionView today={today} />
    </main>
  )
}
