import { NextResponse, type NextRequest } from 'next/server'
import { type EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { logObs } from '@/lib/observability'

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
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      // A bare ?code= landing does not say what kind of link it was. The session's
      // JWT does: GoTrue stamps amr method 'recovery' on a password-recovery
      // session. Send those to the reset page even when `next` did not say so
      // (the dashboard-sent recovery email is exactly this shape).
      const target = isRecoverySession(data?.session?.access_token) ? '/reset-password' : next
      return NextResponse.redirect(`${origin}${target}`)
    }
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
    if (!error) return NextResponse.redirect(`${origin}${next}`)
  }

  await logObs({ subsystem: 'auth', event: 'callback_failed', status: 'error', level: 'error', meta: { type: type ?? 'none', hadCode: Boolean(code), hadTokenHash: Boolean(tokenHash) } })

  // A failed RECOVERY link should land on the reset page's clean "expired" state,
  // not a generic sign-in error, so the person knows to ask for a fresh link.
  if (type === 'recovery' || next === '/reset-password') {
    return NextResponse.redirect(`${origin}/reset-password?error=expired`)
  }
  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}

// Does this access token carry the 'recovery' authentication method? Decodes the
// JWT payload locally (no verification needed: the token came from GoTrue in this
// same exchange; we only read a routing hint from it).
function isRecoverySession(accessToken: string | undefined | null): boolean {
  if (!accessToken) return false
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      amr?: Array<{ method?: string }>
    }
    return Boolean(payload.amr?.some((a) => a?.method === 'recovery'))
  } catch {
    return false
  }
}
