'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isOperator, siteUrl } from '@/lib/auth/operator'
import { inviteByEmail, deleteUser } from '@/lib/supabase/auth-admin'
import { normalizeEmail, isValidEmail, type Invite } from '@/lib/invites'
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

async function requestOrigin(): Promise<string | undefined> {
  const h = await headers()
  const host = h.get('host')
  if (!host) return undefined
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}

export type InviteState = { ok?: boolean; email?: string; actionLink?: string; error?: string }

// Mints an invited account and returns its action link to the operator's screen
// (via useActionState), so it works without SMTP. Public signups stay disabled;
// this admin path is the only way an account is created.
export async function inviteAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const { supabase, user } = await requireOperator()
  const email = normalizeEmail(String(formData.get('email') ?? ''))
  const note = String(formData.get('note') ?? '').trim() || null
  if (!isValidEmail(email)) return { error: 'Enter a valid email address.' }

  // One invite per address. Re-inviting a still-pending or accepted address is a
  // no-op for safety; a revoked address can be re-armed.
  const { data: existing } = await supabase
    .from('invites')
    .select('*')
    .eq('user_id', user.id)
    .eq('email', email)
    .maybeSingle<Invite>()
  if (existing && existing.status === 'accepted') {
    return { error: `${email} already has an account.` }
  }

  const redirectTo = `${siteUrl(await requestOrigin())}/auth/callback?next=/onboarding`
  let actionLink: string
  let invitedUserId: string
  try {
    const res = await inviteByEmail({ email, redirectTo })
    actionLink = res.actionLink
    invitedUserId = res.userId
  } catch (e) {
    return { error: `Could not create the invite: ${e instanceof Error ? e.message : String(e)}` }
  }

  if (existing) {
    await supabase
      .from('invites')
      .update({ status: 'pending', invited_user_id: invitedUserId, note, accepted_at: null })
      .eq('id', existing.id)
      .eq('user_id', user.id)
  } else {
    await supabase
      .from('invites')
      .insert({ user_id: user.id, email, status: 'pending', invited_user_id: invitedUserId, note })
  }

  await logEvent({
    user_id: user.id,
    event_type: 'invite_created',
    name: email,
    attrs: { invitee_user_id: invitedUserId, reinvite: Boolean(existing) },
  })
  revalidatePath('/admin')
  return { ok: true, email, actionLink }
}

// Withdraws an invite. If the invitee has not finished onboarding (status !=
// accepted), the unused auth account is deleted so the link cannot be redeemed.
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

  if (inv.invited_user_id && inv.status !== 'accepted') {
    try {
      await deleteUser(inv.invited_user_id)
    } catch {
      // best effort: the account may already be gone; still mark the row revoked
    }
  }
  await supabase.from('invites').update({ status: 'revoked' }).eq('id', id).eq('user_id', user.id)
  await logEvent({ user_id: user.id, event_type: 'invite_revoked', name: inv.email })
  revalidatePath('/admin')
  redirect('/admin')
}
