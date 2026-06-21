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
export async function isInvited(email: string): Promise<boolean> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('invites')
    .select('id')
    .eq('email', normalizeEmail(email))
    .neq('status', 'revoked')
    .limit(1)
    .maybeSingle()
  return Boolean(data)
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
