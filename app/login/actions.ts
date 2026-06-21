'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveSiteUrl } from '@/lib/auth/operator'
import { isInvited, normalizeEmail, isValidEmail } from '@/lib/invites'

// Returning-user sign-in with email + password. Public signups stay DISABLED; this
// only authenticates an existing account.
export async function login(formData: FormData) {
  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`)
  }

  redirect('/')
}

// Build the request origin from headers (server actions have no URL object).
async function requestOrigin(): Promise<string | undefined> {
  const h = await headers()
  const host = h.get('host')
  if (!host) return undefined
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}

// Create-account / first-time setup for an INVITED person. Invite-only is intact:
// a non-invited email is clearly rejected, and the magic link only signs in an
// existing (invited) account (shouldCreateUser:false, plus signups stay disabled),
// so this never creates a public account. The link sends them into onboarding.
export async function requestAccess(formData: FormData) {
  const email = normalizeEmail(String(formData.get('email') ?? ''))
  if (!isValidEmail(email)) {
    redirect(`/login?error=${encodeURIComponent('Enter a valid email address.')}`)
  }

  if (!(await isInvited(email))) {
    redirect(`/login?error=${encodeURIComponent('This email has not been invited. Ask the operator for an invite.')}`)
  }

  const site = resolveSiteUrl(await requestOrigin())
  if ('error' in site) {
    redirect(`/login?error=${encodeURIComponent(site.error)}`)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${site.url}/auth/callback?next=/onboarding` },
  })
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`)
  }
  redirect(
    `/login?notice=${encodeURIComponent(
      `A sign-in link is on its way to ${email}. Open it to set up your account and start onboarding.`
    )}`
  )
}
