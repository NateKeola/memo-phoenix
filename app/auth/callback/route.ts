import { NextResponse, type NextRequest } from 'next/server'
import { type EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

// Establishes a session from an auth callback, then redirects to `next`.
//
// Handles two link shapes so both password sign-in and invite/magic links work:
//   - PKCE `code`  (exchangeCodeForSession) — the standard OAuth/email-confirm flow
//   - `token_hash` + `type`  (verifyOtp) — how Supabase invite / magic-link emails
//     arrive. An invite link lands here, establishes the session, and `next` sends
//     the new user into onboarding.
// The redirect target must be in the project's additional_redirect_urls.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = searchParams.get('next') ?? '/'

  const supabase = await createClient()

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(`${origin}${next}`)
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
    if (!error) return NextResponse.redirect(`${origin}${next}`)
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
