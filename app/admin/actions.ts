'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { isOperator, resolveSiteUrl } from '@/lib/auth/operator'
import { deleteUser, findUserByEmail, generateRecoveryLink, RecoveryUserMissingError } from '@/lib/supabase/auth-admin'
import { normalizeEmail, isValidEmail, isInvited, type Invite } from '@/lib/invites'
import { logEvent } from '@/lib/telemetry'

// All admin actions re-verify the operator server-side. The /admin page is also
// operator-gated, but never trust the surface: the gate lives here too.
async function requireOperator() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (!isOperator(user)) redirect('/')
  return { supabase, user }
}

export type InviteState = { ok?: boolean; email?: string; error?: string }

// Adds an email to the allowlist (the invites table). That is the WHOLE invite: no
// account is created and no link is generated. The person then creates their own
// account at /login with this exact email and a password (the allowlist is checked
// there server-side, and again on every request by the route guard). Re-inviting a
// revoked address re-arms it; an address that already has an account is rejected.
export async function inviteAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const { supabase, user } = await requireOperator()
  const email = normalizeEmail(String(formData.get('email') ?? ''))
  const note = String(formData.get('note') ?? '').trim() || null
  if (!isValidEmail(email)) return { error: 'Enter a valid email address.' }

  // One invite per address (the unique index is on lower(email)). An accepted
  // address already has an account; a pending or revoked one can be (re-)armed.
  const { data: existing } = await supabase
    .from('invites')
    .select('*')
    .eq('user_id', user.id)
    .eq('email', email)
    .maybeSingle<Invite>()
  if (existing && existing.status === 'accepted') {
    return { error: `${email} already has an account.` }
  }

  if (existing) {
    await supabase
      .from('invites')
      .update({ status: 'pending', note, invited_user_id: null, accepted_at: null })
      .eq('id', existing.id)
      .eq('user_id', user.id)
  } else {
    await supabase
      .from('invites')
      .insert({ user_id: user.id, email, status: 'pending', note })
  }

  await logEvent({
    user_id: user.id,
    event_type: 'invite_created',
    name: email,
    attrs: { reinvite: Boolean(existing) },
  })
  revalidatePath('/admin')
  return { ok: true, email }
}

export type RecoveryState = { ok?: boolean; email?: string; link?: string; error?: string }

// Generates a password-RECOVERY link for an existing, allowlisted account and shows
// it inline (exactly like the invite flow shows an invite). NO email is sent: the
// operator copies the link and sends it to the person out of band (text, etc.). This
// is the reliable recovery path in the beta because the built-in Supabase email
// sender is rate-limited and unreliable. Two gates:
//   1. operator-only (requireOperator, re-checked server-side);
//   2. allowlist-scoped: only the operator's own address or an actively-invited
//      email can be recovered (never an arbitrary or revoked address).
// The link resolves to the DEPLOYED URL via resolveSiteUrl (no silent localhost),
// and points at /auth/callback (token_hash + type=recovery) which establishes the
// recovery session and forwards to /reset-password.
export async function recoveryLinkAction(
  _prev: RecoveryState,
  formData: FormData
): Promise<RecoveryState> {
  const { user } = await requireOperator()
  const email = normalizeEmail(String(formData.get('email') ?? ''))
  if (!isValidEmail(email)) return { error: 'Enter a valid email address.' }

  // Allowlist scope: the operator's own email (configured or their signed-in
  // address), or an address with an active invite. Never an arbitrary or revoked one.
  const operatorEmail = process.env.MEMO_ADMIN_EMAIL?.trim().toLowerCase()
  const signedInEmail = user.email?.trim().toLowerCase()
  const isSelf =
    Boolean(operatorEmail && email === operatorEmail) ||
    Boolean(signedInEmail && email === signedInEmail)
  if (!isSelf && !(await isInvited(email))) {
    return { error: `${email} is not on the allowlist. Only allowlisted users can be recovered.` }
  }

  // Resolve the deployed base URL; refuse loudly rather than mint a dead localhost
  // link (matches the invite-redirect posture).
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? undefined
  const proto = h.get('x-forwarded-proto') ?? 'https'
  const origin = host ? `${proto}://${host}` : undefined
  const site = resolveSiteUrl(origin)
  if ('error' in site) return { error: site.error }

  const next = '/reset-password'
  const redirectTo = `${site.url}/auth/callback?next=${encodeURIComponent(next)}`

  let hashedToken: string
  try {
    const res = await generateRecoveryLink({ email, redirectTo })
    hashedToken = res.hashedToken
  } catch (e) {
    if (e instanceof RecoveryUserMissingError) {
      return { error: `No account exists yet for ${email}. Invite them first, then they set a password.` }
    }
    const msg = e instanceof Error ? e.message : String(e)
    return { error: 'Could not generate a recovery link: ' + msg }
  }

  const link =
    `${site.url}/auth/callback` +
    `?token_hash=${encodeURIComponent(hashedToken)}` +
    `&type=recovery` +
    `&next=${encodeURIComponent(next)}`

  await logEvent({ user_id: user.id, event_type: 'recovery_link_created', name: email })
  revalidatePath('/admin')
  return { ok: true, email, link }
}

// Withdraws an invite. Marks it revoked so the allowlist no longer admits the email
// (the route guard locks the user out on their next request). If a half-onboarded
// account exists (invited_user_id set, status != accepted), the unused account is
// deleted too so it cannot linger.
export async function revokeInviteAction(formData: FormData): Promise<void> {
  const { supabase, user } = await requireOperator()
  const id = String(formData.get('id') ?? '')
  const { data: inv } = await supabase
    .from('invites')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle<Invite>()
  if (!inv) redirect('/admin?error=not_found')

  // Delete the half-onboarded account so a withdrawn invite cannot be redeemed and
  // a revoke+re-invite genuinely resets the person. The account id comes from the
  // linked invited_user_id when present, else by email lookup (the pre-password-auth
  // invites never linked it, which made Todd's account un-resettable). SAFETY: only
  // an account that is invited=true and NOT onboarded is ever deleted; an onboarded
  // account has real data and is never touched here.
  if (inv.status !== 'accepted') {
    try {
      let accountId: string | null = inv.invited_user_id
      if (!accountId) {
        const found = await findUserByEmail(inv.email)
        if (found && found.invited && !found.onboarded) accountId = found.id
      }
      if (accountId) await deleteUser(accountId)
    } catch {
      // best effort: the account may already be gone; still mark the row revoked
    }
  }
  await supabase.from('invites').update({ status: 'revoked' }).eq('id', id).eq('user_id', user.id)
  await logEvent({ user_id: user.id, event_type: 'invite_revoked', name: inv.email })
  revalidatePath('/admin')
  redirect('/admin')
}
