'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isOperator } from '@/lib/auth/operator'
import { deleteUser } from '@/lib/supabase/auth-admin'
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
