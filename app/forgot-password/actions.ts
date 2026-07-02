'use server'

import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { resolveSiteUrl } from '@/lib/auth/operator'
import { normalizeEmail, isValidEmail, isInvited } from '@/lib/invites'

export type ForgotState = { ok?: boolean; message?: string; error?: string }

// Self-service password recovery. The user enters their email and Supabase emails
// them a reset link (custom SMTP is configured, so delivery is reliable). No admin in
// the loop. Two properties hold:
//   1. Allowlist-scoped: a real send happens ONLY for an allowlisted address (the
//      operator's own email or an active/non-revoked invite), so recovery cannot mint
//      or touch a non-account.
//   2. Enumeration-safe: the SAME neutral message is returned whether or not the email
//      is registered/allowlisted, so the form never reveals which addresses exist.
//
// The reset link resolves to the DEPLOYED URL (resolveSiteUrl, no silent localhost)
// and routes through /auth/callback, which establishes the recovery session (code or
// token_hash) and forwards to /reset-password where the user sets a new password.
export async function requestResetEmailAction(
  _prev: ForgotState,
  formData: FormData
): Promise<ForgotState> {
  const email = normalizeEmail(String(formData.get('email') ?? ''))
  if (!isValidEmail(email)) return { error: 'Enter a valid email address.' }

  const neutral: ForgotState = {
    ok: true,
    message: 'If an account exists for that email, a reset link is on its way. It can take a minute to arrive.',
  }

  // Only actually send to an allowlisted address; return the neutral message either
  // way (no account / allowlist enumeration).
  const operatorEmail = process.env.MEMO_ADMIN_EMAIL?.trim().toLowerCase()
  const allowed = Boolean(operatorEmail && email === operatorEmail) || (await isInvited(email))
  if (!allowed) return neutral

  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? undefined
  const proto = h.get('x-forwarded-proto') ?? 'https'
  const origin = host ? `${proto}://${host}` : undefined
  const site = resolveSiteUrl(origin)
  if ('error' in site) return neutral // do not leak config errors to an anonymous form

  const redirectTo = `${site.url}/auth/callback?next=${encodeURIComponent('/reset-password')}`
  const supabase = await createClient()
  await supabase.auth.resetPasswordForEmail(email, { redirectTo })
  return neutral
}
