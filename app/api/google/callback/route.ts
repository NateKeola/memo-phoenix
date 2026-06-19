import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { emailFromIdToken, exchangeCode } from '@/lib/google/oauth'
import { saveConnection } from '@/lib/google/connection'

export const runtime = 'nodejs'

// Google redirects here after consent. Verify the state cookie, exchange the code
// for tokens, and store them server-side (the tokens never reach the browser).
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', request.url))

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const denied = url.searchParams.get('error')
  const cookieState = request.cookies.get('g_oauth_state')?.value

  if (denied) return NextResponse.redirect(new URL('/companion?google=denied', request.url))
  if (!code || !state || !cookieState || state !== cookieState) {
    return NextResponse.redirect(new URL('/companion?google=state_mismatch', request.url))
  }

  try {
    const tokens = await exchangeCode(code, `${url.origin}/api/google/callback`)
    await saveConnection(user.id, tokens, emailFromIdToken(tokens.id_token))
  } catch (err) {
    console.error('[google] callback:', err)
    return NextResponse.redirect(new URL('/companion?google=error', request.url))
  }

  const res = NextResponse.redirect(new URL('/companion?google=connected', request.url))
  res.cookies.delete('g_oauth_state')
  return res
}
