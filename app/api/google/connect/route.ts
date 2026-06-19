import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildAuthUrl, googleConfigured } from '@/lib/google/oauth'

export const runtime = 'nodejs'

// Start the Google connection: redirect the signed-in user to Google's consent
// screen for gmail.send + calendar.events (offline access). A random state is
// stored in an httpOnly cookie and verified on callback (CSRF guard).
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', request.url))
  if (!googleConfigured()) return NextResponse.redirect(new URL('/companion?google=unconfigured', request.url))

  const origin = new URL(request.url).origin
  const redirectUri = `${origin}/api/google/callback`
  const state = crypto.randomUUID()
  const res = NextResponse.redirect(buildAuthUrl(redirectUri, state))
  res.cookies.set('g_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  })
  return res
}
