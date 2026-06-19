import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getToday } from '@/lib/companion/today'
import { connectionStatus } from '@/lib/google/connection'
import { googleConfigured } from '@/lib/google/oauth'
import { logEvent } from '@/lib/telemetry'
import { CompanionView } from '@/components/companion/companion-view'

export const dynamic = 'force-dynamic'

// The companion "today" surface. Deterministic selection (no model); drafting and
// sending happen on demand from the client, code-gated server-side.
export default async function CompanionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const today = await getToday({ supabase, userId: user.id }, Date.now())
  const status = await connectionStatus(user.id)
  const sp = await searchParams

  await logEvent({ user_id: user.id, event_type: 'companion_surfaced', attrs: { ...today.counts } })

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 760 }}>
      <p>
        <Link href="/">&larr; Home</Link>
      </p>
      <h1>Today</h1>
      <p style={{ color: '#666' }}>
        Follow-ups from your graph. Memo can draft an email or a calendar invite, but nothing sends
        until you review and confirm it.
      </p>
      <CompanionView
        today={today}
        connection={{ connected: status.connected, email: status.email, configured: googleConfigured() }}
        googleNotice={sp.google ?? null}
      />
    </main>
  )
}
