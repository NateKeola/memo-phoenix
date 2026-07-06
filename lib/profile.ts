import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

// User-owned profile: a display name + a private avatar image. Never canonical. The
// avatar lives in the private 'avatars' Storage bucket (per-user RLS); it is served
// only via short-lived signed URLs generated for the owning user.

export const AVATAR_BUCKET = 'avatars'
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024 // 5 MB (matches the bucket limit)
// content-type -> file extension. The keys are the only accepted image types.
export const AVATAR_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
export const AVATAR_TYPE_LABEL = 'PNG, JPG, WEBP, or GIF, up to 5 MB'

export type Profile = {
  displayName: string
  avatarPath: string | null
  avatarUrl: string | null // short-lived signed URL, null when no photo
  initial: string
}

// Resolve the user's profile for display. Reads user_profiles (RLS-scoped) and, when
// an avatar is set, signs a short-lived URL for it (the bucket is private). The
// display name falls back to MEMO_USER_NAME then the email local-part. Never touches
// canonical; degrades gracefully (env + email) if the table/read fails.
export async function getProfile(
  supabase: SupabaseClient,
  user: { id: string; email?: string | null }
): Promise<Profile> {
  let displayName = ''
  let avatarPath: string | null = null
  try {
    const { data } = await supabase
      .from('user_profiles')
      .select('display_name, avatar_path')
      .eq('user_id', user.id)
      .maybeSingle()
    const row = data as { display_name: string | null; avatar_path: string | null } | null
    displayName = (row?.display_name ?? '').trim()
    avatarPath = row?.avatar_path ?? null
  } catch {
    // table missing / read error: never break the page
  }
  const name = displayName || process.env.MEMO_USER_NAME || user.email?.split('@')[0] || 'You'

  let avatarUrl: string | null = null
  if (avatarPath) {
    try {
      const { data } = await supabase.storage.from(AVATAR_BUCKET).createSignedUrl(avatarPath, 60 * 60)
      avatarUrl = data?.signedUrl ?? null
    } catch {
      avatarUrl = null
    }
  }
  const initial = (name || user.email || '?').trim().charAt(0).toUpperCase() || '?'
  return { displayName: name, avatarPath, avatarUrl, initial }
}
