import { NextResponse, type NextRequest } from 'next/server'
import { authorizeApiUser } from '@/lib/auth/guard'
import { setOnboarded } from '@/lib/supabase/auth-admin'
import { markInviteAccepted } from '@/lib/invites'
import { logEvent } from '@/lib/telemetry'

export const runtime = 'nodejs'

// Called by the onboarding interview once its capture is written. Marks the user
// onboarded (in app_metadata, so the middleware gate releases them into the app)
// and flips their invite to accepted. The actual mine is kicked off by the
// /building page (the Vercel run route or the Action), so this stays fast.
export async function POST(request: NextRequest) {
  const auth = await authorizeApiUser()
  if ('error' in auth) return auth.error
  const { user } = auth
  // skipped=true marks a deliberate escape-hatch completion (the user chose to set
  // Memo up later); the gate releases them either way, but telemetry distinguishes
  // a real first interview from a skip.
  const body = (await request.json().catch(() => ({}))) as { skipped?: boolean }
  const skipped = body.skipped === true

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

  await logEvent({ user_id: user.id, event_type: 'onboarding_completed', name: skipped ? 'skipped' : 'interviewed', attrs: { skipped } })
  return NextResponse.json({ ok: true })
}
