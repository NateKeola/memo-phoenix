'use server'

import { revalidatePath } from 'next/cache'
import { authorizeAction } from '@/lib/auth/guard'
import { logEvent } from '@/lib/telemetry'
import { AVATAR_BUCKET, AVATAR_MAX_BYTES, AVATAR_TYPES } from '@/lib/profile'

// Profile server actions. All write ONLY user-owned metadata (user_profiles + the
// private avatars bucket), scoped to the signed-in user via the RLS client. Never
// canonical. authorizeAction enforces auth + the allowlist on every call.

export type ProfileResult = { ok: boolean; error?: string }

const MAX_NAME = 80

export async function updateDisplayName(input: { displayName: string }): Promise<ProfileResult> {
  const auth = await authorizeAction()
  if (!auth.ok) return { ok: false, error: auth.reason === 'forbidden' ? 'not authorized' : 'unauthorized' }
  const { supabase, user } = auth
  const name = (input.displayName ?? '').trim().slice(0, MAX_NAME)
  if (!name) return { ok: false, error: 'name cannot be empty' }

  const { error } = await supabase
    .from('user_profiles')
    .upsert({ user_id: user.id, display_name: name, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) return { ok: false, error: error.message }
  await logEvent({ user_id: user.id, event_type: 'profile_update', name: 'display_name', attrs: {} })
  revalidatePath('/settings')
  revalidatePath('/')
  return { ok: true }
}

export async function uploadAvatar(formData: FormData): Promise<ProfileResult> {
  const auth = await authorizeAction()
  if (!auth.ok) return { ok: false, error: auth.reason === 'forbidden' ? 'not authorized' : 'unauthorized' }
  const { supabase, user } = auth

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'no image selected' }
  const ext = AVATAR_TYPES[file.type]
  if (!ext) return { ok: false, error: 'image must be PNG, JPG, WEBP, or GIF' }
  if (file.size > AVATAR_MAX_BYTES) return { ok: false, error: 'image must be under 5 MB' }

  // Read the previous path so it can be cleaned up. Upload under a FRESH name so the
  // new photo is never masked by a browser-cached signed URL of the old one. The path
  // is always under the user's own uid folder, so the storage RLS isolates it.
  const { data: prev } = await supabase.from('user_profiles').select('avatar_path').eq('user_id', user.id).maybeSingle()
  const oldPath = (prev as { avatar_path: string | null } | null)?.avatar_path ?? null
  const path = `${user.id}/avatar_${Date.now()}.${ext}`
  const buf = Buffer.from(await file.arrayBuffer())
  const up = await supabase.storage.from(AVATAR_BUCKET).upload(path, buf, { contentType: file.type, upsert: true })
  if (up.error) return { ok: false, error: up.error.message }

  const { error } = await supabase
    .from('user_profiles')
    .upsert({ user_id: user.id, avatar_path: path, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) return { ok: false, error: error.message }

  if (oldPath && oldPath !== path) {
    try {
      await supabase.storage.from(AVATAR_BUCKET).remove([oldPath])
    } catch {
      // a leftover object is harmless (still RLS-isolated); do not fail the upload
    }
  }
  await logEvent({ user_id: user.id, event_type: 'profile_update', name: 'avatar', attrs: { bytes: file.size, type: file.type } })
  revalidatePath('/settings')
  revalidatePath('/')
  return { ok: true }
}

export async function removeAvatar(): Promise<ProfileResult> {
  const auth = await authorizeAction()
  if (!auth.ok) return { ok: false, error: auth.reason === 'forbidden' ? 'not authorized' : 'unauthorized' }
  const { supabase, user } = auth

  const { data: prev } = await supabase.from('user_profiles').select('avatar_path').eq('user_id', user.id).maybeSingle()
  const oldPath = (prev as { avatar_path: string | null } | null)?.avatar_path ?? null
  const { error } = await supabase
    .from('user_profiles')
    .upsert({ user_id: user.id, avatar_path: null, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) return { ok: false, error: error.message }
  if (oldPath) {
    try {
      await supabase.storage.from(AVATAR_BUCKET).remove([oldPath])
    } catch {
      /* best-effort */
    }
  }
  await logEvent({ user_id: user.id, event_type: 'profile_update', name: 'avatar_removed', attrs: {} })
  revalidatePath('/settings')
  revalidatePath('/')
  return { ok: true }
}
