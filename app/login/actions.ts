'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

// Single-user sign-in. There is deliberately no sign-up action: the one account
// is provisioned out-of-band and remote signups are disabled.
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
