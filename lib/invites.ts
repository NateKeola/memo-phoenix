import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'

// Invite shapes and the service-role accept path. The operator-facing CRUD over
// `invites` runs through the RLS client (user_id = the operator) in the admin
// actions; this module holds the pieces that need the service role or are shared.

export type InviteStatus = 'pending' | 'accepted' | 'revoked'

export type Invite = {
  id: string
  user_id: string
  email: string
  status: InviteStatus
  invited_user_id: string | null
  note: string | null
  created_at: string
  accepted_at: string | null
}

// Addresses are stored lowercased/trimmed so the unique index and lookups agree.
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function isValidEmail(raw: string): boolean {
  return EMAIL_RE.test(normalizeEmail(raw))
}

// Is this email currently invited (pending or accepted, not revoked)? Service-role
// because the actor is an UNAUTHENTICATED visitor on the login page (the Create
// account path), so the RLS client cannot read the operator-owned invites row. The
// email is the only input; we never expose the invite contents.
//
// DEFENSE IN DEPTH (audit finding): the invites RLS policies let any authenticated
// user INSERT rows scoped to their own user_id, and this check used to match by
// email alone, so an already-invited user with the anon key could have appended an
// invites row and allowlisted an arbitrary address. Only rows OWNED BY THE OPERATOR
// count now (MEMO_USER_ID; when unset, the old email-only behavior applies with a
// warning, so a missing env cannot lock the beta out).
export async function isInvited(email: string): Promise<boolean> {
  const admin = createAdminClient()
  let q = admin
    .from('invites')
    .select('id')
    .eq('email', normalizeEmail(email))
    .neq('status', 'revoked')
  const operatorId = process.env.MEMO_USER_ID?.trim()
  if (operatorId) {
    q = q.eq('user_id', operatorId)
  } else {
    console.warn('[invites] MEMO_USER_ID unset: isInvited cannot verify the invite owner (allowlist is email-only)')
  }
  const { data } = await q.limit(1).maybeSingle()
  return Boolean(data)
}

// Links the freshly created account to its invite row at signup time. The account
// is now minted when the invitee chooses a password (not at invite time), so we
// stamp invited_user_id here so markInviteAccepted (keyed on it) works at the end
// of onboarding and revoke can delete an unused account. Service-role because the
// row is operator-owned (the invitee cannot write it under RLS). Skips revoked rows.
export async function linkInviteAccount(email: string, userId: string): Promise<void> {
  const admin = createAdminClient()
  await admin
    .from('invites')
    .update({ invited_user_id: userId })
    .eq('email', normalizeEmail(email))
    .neq('status', 'revoked')
}

// Marks an invite accepted once its invitee finishes onboarding. Runs as the
// service role because the actor here is the INVITEE (not the operator who owns
// the row), so the RLS client could not update it. Scoped by the invitee's own
// auth id, which we stamped onto the row at invite time, so it can only ever flip
// the invite that belongs to this exact user.
export async function markInviteAccepted(invitedUserId: string): Promise<void> {
  const admin = createAdminClient()
  await admin
    .from('invites')
    .update({ status: 'accepted', accepted_at: new Date().toISOString() })
    .eq('invited_user_id', invitedUserId)
    .neq('status', 'revoked')
}
