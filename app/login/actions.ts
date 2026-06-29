'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { validatePassword } from '@/lib/auth/password'
import { isInvited, linkInviteAccount, normalizeEmail, isValidEmail } from '@/lib/invites'
import { createInvitedAccount, AccountExistsError } from '@/lib/supabase/auth-admin'

// Email + password auth. No email is ever sent: login and signup both complete
// in-band. Signup is gated by the invite allowlist and the account is minted via
// the service role (public platform signups stay disabled). See lib/auth/guard.ts
// for the per-request allowlist boundary that backs this up on every route.

// Returning-user sign-in. Authenticates an existing account with email + password.
export async function login(formData: FormData) {
  const email = normalizeEmail(String(formData.get('email') ?? ''))
  const password = String(formData.get('password') ?? '')

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}&mode=signin`)
  }
  // Send to home; middleware routes a half-onboarded user on into /onboarding.
  redirect('/')
}

// First-time setup for an INVITED person: they choose a password and are logged in
// immediately, with no email. Invite-only is enforced here (allowlist check before
// anything is created) and structurally (the account is minted via the service-role
// admin API; the public GoTrue signup endpoint stays disabled, so there is no path
// to an un-allowlisted account). On success they land in onboarding.
export async function createAccount(formData: FormData) {
  const email = normalizeEmail(String(formData.get('email') ?? ''))
  const password = String(formData.get('password') ?? '')

  if (!isValidEmail(email)) {
    redirect(`/login?error=${encodeURIComponent('Enter a valid email address.')}&mode=create`)
  }
  const pw = validatePassword(password)
  if (!pw.ok) {
    redirect(`/login?error=${encodeURIComponent(pw.error)}&mode=create`)
  }

  // The allowlist gate. A non-approved email is clearly rejected and no account is
  // created. isInvited is service-role (the visitor is unauthenticated here).
  if (!(await isInvited(email))) {
    redirect(
      `/login?error=${encodeURIComponent(
        "This email isn't authorized to register. Contact your admin for an invite."
      )}&mode=create`
    )
  }

  let userId: string
  try {
    const res = await createInvitedAccount({ email, password })
    userId = res.userId
  } catch (e) {
    if (e instanceof AccountExistsError) {
      redirect(
        `/login?error=${encodeURIComponent(
          'An account already exists for this email. Sign in instead.'
        )}&mode=signin`
      )
    }
    const msg = e instanceof Error ? e.message : String(e)
    redirect(`/login?error=${encodeURIComponent('Could not create your account: ' + msg)}&mode=create`)
  }

  // Link the new account to its invite row (so revoke can clean it up and the
  // onboarding-complete step can mark the invite accepted), then sign in.
  await linkInviteAccount(email, userId)
  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}&mode=signin`)
  }
  redirect('/onboarding')
}
