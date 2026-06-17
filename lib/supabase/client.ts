import { createBrowserClient } from '@supabase/ssr'

// Browser client. Anon key only. Used by the login form.
// Never imports the service-role key.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
