import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { refreshAccessToken, type TokenResponse } from './oauth'

// Google tokens live in google_connections, which is server-only (FORCE RLS, no
// policies), so they never reach the browser. Only the service-role admin client
// touches the table. This module is the single read/write point.
const TABLE = 'google_connections'

export type GoogleConnection = {
  user_id: string
  email: string | null
  access_token: string | null
  refresh_token: string | null
  scope: string | null
  expiry: string | null
}

export async function getConnection(userId: string): Promise<GoogleConnection | null> {
  const admin = createAdminClient()
  const { data, error } = await admin.from(TABLE).select('*').eq('user_id', userId).maybeSingle()
  if (error) {
    console.error('[google] getConnection:', error.message)
    return null
  }
  return (data as GoogleConnection | null) ?? null
}

// Connection status for the UI. Never returns tokens, only whether a usable
// connection exists and which account it is.
export async function connectionStatus(userId: string): Promise<{ connected: boolean; email: string | null }> {
  const c = await getConnection(userId)
  return { connected: Boolean(c?.refresh_token), email: c?.email ?? null }
}

export async function saveConnection(userId: string, t: TokenResponse, email: string | null): Promise<void> {
  const admin = createAdminClient()
  const existing = await getConnection(userId)
  // Google omits refresh_token on re-consent sometimes; keep the stored one.
  const refresh = t.refresh_token ?? existing?.refresh_token ?? null
  const expiry = new Date(Date.now() + Math.max(0, t.expires_in - 60) * 1000).toISOString()
  const { error } = await admin.from(TABLE).upsert(
    {
      user_id: userId,
      email: email ?? existing?.email ?? null,
      access_token: t.access_token,
      refresh_token: refresh,
      scope: t.scope ?? existing?.scope ?? null,
      expiry,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  )
  if (error) throw new Error(`[google] saveConnection: ${error.message}`)
}

// A valid access token, refreshed if expired. Throws NOT_CONNECTED when there is
// no usable connection, so callers can prompt the user to connect.
export async function getValidAccessToken(userId: string): Promise<string> {
  const c = await getConnection(userId)
  if (!c?.refresh_token) throw new Error('NOT_CONNECTED')
  const stillValid = c.access_token && c.expiry && Date.parse(c.expiry) > Date.now()
  if (stillValid && c.access_token) return c.access_token
  const t = await refreshAccessToken(c.refresh_token)
  await saveConnection(userId, t, c.email)
  return t.access_token
}

export async function disconnect(userId: string): Promise<void> {
  const admin = createAdminClient()
  const { error } = await admin.from(TABLE).delete().eq('user_id', userId)
  if (error) throw new Error(`[google] disconnect: ${error.message}`)
}
