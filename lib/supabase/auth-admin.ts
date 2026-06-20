import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'

// Service-role Auth admin helpers. These are the ONLY way an account is created in
// the invite-only beta: public signups stay disabled, and the admin API is exempt
// from that toggle, so minting an account requires this server-only path. The
// service-role key never reaches the browser (lib/supabase/admin.ts is server-only).

// Creates (or re-arms) an invited account and returns its action link. We use
// generateLink(type:'invite') rather than inviteUserByEmail so the operator gets
// the link back directly and can share it even when no SMTP is configured (a small
// trusted beta). If SMTP IS configured, Supabase also emails it. We then stamp
// app_metadata.invited so the onboarding gate can recognize a first-run user
// WITHOUT a database round-trip (the flag rides in the JWT). The pre-existing
// operator has no such flag and is therefore never forced into onboarding.
export async function inviteByEmail(opts: {
  email: string
  redirectTo: string
}): Promise<{ actionLink: string; userId: string }> {
  const admin = createAdminClient()
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'invite',
    email: opts.email,
    options: { redirectTo: opts.redirectTo },
  })
  if (error) throw error
  const actionLink = data?.properties?.action_link
  const userId = data?.user?.id
  if (!actionLink || !userId) throw new Error('generateLink returned no action link / user')

  // Merge invited=true into app_metadata (do not clobber anything Supabase set).
  const existing = (data.user.app_metadata ?? {}) as Record<string, unknown>
  const { error: metaErr } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { ...existing, invited: true, onboarded: false },
  })
  if (metaErr) throw metaErr

  return { actionLink, userId }
}

// Marks onboarding complete in app_metadata. Tamper-resistant: app_metadata is
// settable only by the service role (a user cannot flip their own), and it is
// returned by auth.getUser(), so the middleware gate reads it with no DB query.
export async function setOnboarded(userId: string): Promise<void> {
  const admin = createAdminClient()
  const { data, error: getErr } = await admin.auth.admin.getUserById(userId)
  if (getErr) throw getErr
  const existing = (data?.user?.app_metadata ?? {}) as Record<string, unknown>
  const { error } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { ...existing, onboarded: true },
  })
  if (error) throw error
}

// Hard-revokes an invited account that has not been used. Used by the operator's
// revoke action so a withdrawn invite cannot later be redeemed.
export async function deleteUser(userId: string): Promise<void> {
  const admin = createAdminClient()
  const { error } = await admin.auth.admin.deleteUser(userId)
  if (error) throw error
}
