import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

// Bridges an IMPLICIT-flow recovery link into a server session. Older Supabase
// email templates and GoTrue verify redirects deliver the session as URL FRAGMENT
// tokens (#access_token=...&type=recovery), which never reach the server, and this
// app deliberately has no browser Supabase client to consume them. The client-side
// catcher (components/auth/recovery-hash-catcher.tsx) posts the tokens here; we set
// the session cookies (the tokens ARE the user's credentials, minted by GoTrue for
// this exact purpose) and validate them with getUser before confirming, then the
// client continues to /reset-password.
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
  }
  if (!body.access_token || !body.refresh_token) {
    return NextResponse.json({ error: 'missing tokens' }, { status: 400 })
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.setSession({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  // Validate against the auth server; invalid or expired tokens do not get a 200.
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'invalid session' }, { status: 401 })

  return NextResponse.json({ ok: true })
}
