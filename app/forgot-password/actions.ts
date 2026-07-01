'use server'

import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { resolveSiteUrl } from '@/lib/auth/operator'
import { normalizeEmail, isValidEmail, isInvited } from '@/lib/invites'

export type ForgotState = { ok?: boolean; message?: string; error?: string }

// OPTIONAL self-service "email me a reset link" path. It is DISABLED by default and
// only enabled when the operator sets RECOVERY_EMAIL_SELF_SERVICE=1 AND has configured
// custom SMTP in Supabase. Without SMTP, Supabase's built-in sender is rate-limited
// and unreliable (that is exactly why the dashboard recovery email did not arrive),
// so we do NOT show or run this path by default; the admin recovery-link path is the
// one that works. See docs/HANDOFF.md for the SMTP operator note.
//
// When enabled, it is allowlist-scoped and enumeration-safe: it only actually sends
// to an allowlisted address, but ALWAYS returns the same neutral message, so it
// never reveals whether an email has an account or is on the allowlist.
export async function requestResetEmailAction(
  _prev: ForgotState,
  formData: FormData
): Promise<ForgotState> {
  const enabled = process.env.RECOVERY_EMAIL_SELF_SERVICE === '1'
  if (!enabled) {
    return { error: 'Self-service email recovery is not enabled. Please contact your admin.' }
  }

  const email = normalizeEmail(String(formData.get('email') ?? ''))
  if (!isValidEmail(email)) return { error: 'Enter a valid email address.' }

  const neutral: ForgotState = {
    ok: true,
    message: 'If an account exists for that email, a reset link has been sent. It can take a minute to arrive.',
  }

  // Only send to an allowlisted address; return the neutral message either way (no
  // account/allowlist enumeration).
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
