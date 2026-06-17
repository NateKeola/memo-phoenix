import 'server-only'
import { createClient } from '@supabase/supabase-js'

// Service-role client. Bypasses RLS by design (invariant 4: only the server,
// never the client, writes canonical and telemetry rows).
//
// The `server-only` import above makes any client-side import of this module a
// build error, so the service-role key can never reach the browser bundle.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceRoleKey) {
    throw new Error(
      'createAdminClient: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set'
    )
  }

  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
