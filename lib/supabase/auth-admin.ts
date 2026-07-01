import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'

// Service-role Auth admin helpers. These are the ONLY way an account is created in
// the invite-only beta: public signups stay disabled, and the admin API is exempt
// from that toggle, so minting an account requires this server-only path. The
// service-role key never reaches the browser (lib/supabase/admin.ts is server-only).

// Sentinel the create-account action can branch on: the email already has an
// account, so the person should sign in instead of registering.
export class AccountExistsError extends Error {
  constructor(email: string) {
    super(`An account already exists for ${email}.`)
    this.name = 'AccountExistsError'
  }
}

// Mints the allowlisted user's account with their chosen password and returns its
// id. NO email is sent: public signups stay disabled and this admin path is exempt
// from that toggle, and email_confirm:true pre-confirms the address so there is no
// verification step (the allowlist already established the user is approved). The
// caller (the create-account action) checks the invite allowlist BEFORE calling
// this, then signs the user in with the same password. We stamp app_metadata so the
// onboarding gate recognizes a first-run user WITHOUT a DB round-trip (the flag
// rides in the JWT); the pre-existing operator has no such flag and is never forced
// into onboarding.
export async function createInvitedAccount(opts: {
  email: string
  password: string
}): Promise<{ userId: string }> {
  const admin = createAdminClient()
  const { data, error } = await admin.auth.admin.createUser({
    email: opts.email,
    password: opts.password,
    email_confirm: true,
    app_metadata: { invited: true, onboarded: false },
  })
  if (error) {
    // GoTrue returns a 422 "already been registered" when the email exists.
    if (/already.*registered|already.*exists/i.test(error.message)) {
      throw new AccountExistsError(opts.email)
    }
    throw error
  }
  const userId = data?.user?.id
  if (!userId) throw new Error('createUser returned no user')
  return { userId }
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

// Sentinel the recovery action can branch on: there is no account for this email,
// so there is nothing to recover (the operator should invite them instead).
export class RecoveryUserMissingError extends Error {
  constructor(email: string) {
    super(`No account exists for ${email}.`)
    this.name = 'RecoveryUserMissingError'
  }
}

// Mints a password-RECOVERY link for an existing account, WITHOUT sending any email
// (the admin API is exempt from SMTP entirely; the built-in Supabase sender is
// rate-limited and unreliable, which is why the dashboard recovery email did not
// arrive). The operator copies the returned link and sends it out of band. The
// caller must have already confirmed the email is allowlisted.
//
// We return the `hashed_token` so the caller can build a link at OUR /auth/callback
// (token_hash + type=recovery -> verifyOtp establishes the recovery session), the
// same shape the invite/magic-link path already uses, rather than the Supabase-hosted
// action_link. That keeps recovery on the deployed domain and reuses the tested
// callback. `redirectTo` is passed through for completeness (and must be in the
// Supabase Auth Redirect URLs allowlist) in case the raw action_link is ever used.
export async function generateRecoveryLink(opts: {
  email: string
  redirectTo: string
}): Promise<{ hashedToken: string; actionLink: string }> {
  const admin = createAdminClient()
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: opts.email,
    options: { redirectTo: opts.redirectTo },
  })
  if (error) {
    // GoTrue returns a 404/"user not found" when the email has no account.
    if (/not.*found|no.*user|user.*not.*exist/i.test(error.message)) {
      throw new RecoveryUserMissingError(opts.email)
    }
    throw error
  }
  const hashedToken = data?.properties?.hashed_token
  const actionLink = data?.properties?.action_link
  if (!hashedToken || !actionLink) {
    throw new Error('generateLink(recovery) returned no token')
  }
  return { hashedToken, actionLink }
}
