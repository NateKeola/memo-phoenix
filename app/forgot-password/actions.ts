'use server'

import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { resolveSiteUrl } from '@/lib/auth/operator'
import { normalizeEmail, isValidEmail, isInvited } from '@/lib/invites'
import { createAdminClient } from '@/lib/supabase/admin'

// Is this the operator's own email? MEMO_ADMIN_EMAIL when set, else the email on
// the MEMO_USER_ID account (service-role lookup; cheap, only on this cold path).
async function isOperatorEmail(email: string): Promise<boolean> {
  const configured = process.env.MEMO_ADMIN_EMAIL?.trim().toLowerCase()
  if (configured) return email === configured
  const operatorId = process.env.MEMO_USER_ID?.trim()
  if (!operatorId) return false
  try {
    const admin = createAdminClient()
    const { data } = await admin.auth.admin.getUserById(operatorId)
    return (data?.user?.email ?? '').trim().toLowerCase() === email
  } catch {
    return false
  }
}

export type ForgotState = { ok?: boolean; message?: string; error?: string }

// Self-service password recovery: the user enters their email and Supabase emails a
// reset link. ALWAYS available (the audit found the admin-only framing was a dead
// end: there is no admin surface a locked-out user can reach). Two properties hold:
//   1. Allowlist-scoped: a real send happens ONLY for an allowlisted address (the
//      operator's own email or an active invite), so recovery cannot touch a
//      non-account.
//   2. Enumeration-safe: the SAME neutral message returns whether or not the email
//      is registered or allowlisted.
//
// DELIVERY HONESTY: until custom SMTP is configured in Supabase (Authentication ->
// SMTP; the live project currently has none), the built-in sender is rate-limited
// (~2/hour) and may not deliver. The page copy tells the user what to do if no
// email arrives (ask the operator for a direct recovery link, the /admin path,
// which needs no email at all). Configure SMTP to make this path fully reliable.
//
// The link resolves to the DEPLOYED URL (resolveSiteUrl, no silent localhost) and
// routes through /auth/callback, which establishes the session and forwards to
// /reset-password; root landings and fragment tokens are also caught (middleware +
// RecoveryHashCatcher), so however GoTrue shapes the link it ends at the reset page.
export async function requestResetEmailAction(
  _prev: ForgotState,
  formData: FormData
): Promise<ForgotState> {
  const email = normalizeEmail(String(formData.get('email') ?? ''))
  if (!isValidEmail(email)) return { error: 'Enter a valid email address.' }

  const neutral: ForgotState = {
    ok: true,
    message:
      'If an account exists for that email, a reset link is on its way. It can take a few minutes; ' +
      'if nothing arrives, contact your admin for a direct recovery link.',
  }

  // Only actually send to an allowlisted address; return the neutral message either
  // way (no account/allowlist enumeration). The operator has no invite row, so
  // their own address is admitted via MEMO_ADMIN_EMAIL or, when that is unset (the
  // live deployed state), by looking up the MEMO_USER_ID account's email; without
  // the fallback the operator's own reset silently never sent.
  const allowed = (await isOperatorEmail(email)) || (await isInvited(email))
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
