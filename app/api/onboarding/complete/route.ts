import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { setOnboarded } from '@/lib/supabase/auth-admin'
import { markInviteAccepted } from '@/lib/invites'
import { logEvent } from '@/lib/telemetry'

export const runtime = 'nodejs'

// Called by the onboarding interview once its capture is written. Marks the user
// onboarded (in app_metadata, so the middleware gate releases them into the app)
// and flips their invite to accepted. The actual mine is kicked off by the
// /building page (the Vercel run route or the Action), so this stays fast.
export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  try {
    await setOnboarded(user.id)
  } catch (e) {
    console.error('[onboarding/complete] setOnboarded:', e)
    return NextResponse.json({ error: 'could not complete onboarding' }, { status: 500 })
  }

  // Non-fatal: onboarding is complete even if the invite bookkeeping update fails.
  try {
    await markInviteAccepted(user.id)
  } catch (e) {
    console.error('[onboarding/complete] markInviteAccepted:', e)
  }

  await logEvent({ user_id: user.id, event_type: 'onboarding_completed', attrs: {} })
  return NextResponse.json({ ok: true })
}
