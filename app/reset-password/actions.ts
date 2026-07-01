'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { validatePassword } from '@/lib/auth/password'

// Sets a new password on the current RECOVERY session. The user reached
// /reset-password through a recovery link, which /auth/callback verified (verifyOtp)
// and turned into an authenticated session cookie. So the RLS server client here is
// bound to that session, and updateUser sets the password for exactly that account.
// No service role and no email involved.
export async function updatePasswordAction(formData: FormData) {
  const password = String(formData.get('password') ?? '')
  const confirm = String(formData.get('confirm') ?? '')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  // No live recovery session (expired/invalid link, or landed here directly). Show
  // the clean expired state rather than a confusing failure.
  if (!user) redirect('/reset-password?error=expired')

  const pw = validatePassword(password)
  if (!pw.ok) {
    redirect(`/reset-password?error=${encodeURIComponent(pw.error)}`)
  }
  if (password !== confirm) {
    redirect(`/reset-password?error=${encodeURIComponent('The two passwords do not match.')}`)
  }

  const { error } = await supabase.auth.updateUser({ password })
  if (error) {
    redirect(`/reset-password?error=${encodeURIComponent(error.message)}`)
  }

  // Password set and still signed in. Home; middleware routes a not-yet-onboarded
  // user on into onboarding if that ever applies.
  redirect('/')
}
