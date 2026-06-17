import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { requireEnv } from './config'

// Service-role client. Bypasses RLS by design: the miner is the only writer of
// canonical rows (invariant 4), and writes telemetry server-side. The service
// role has no auth.uid(), so user_id is always stamped explicitly.
let cached: SupabaseClient | null = null

export function admin(): SupabaseClient {
  if (cached) return cached
  const { url, serviceRoleKey } = requireEnv()
  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}
