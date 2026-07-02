import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/telemetry'
import type { CaptureTargetKind } from '@/lib/capture-target'

export type CaptureMode = 'text' | 'memo' | 'interview'
export type CaptureModality = 'text' | 'voice'

export type CaptureInput = {
  mode: CaptureMode
  modality: CaptureModality
  body: string
  routingHint?: string | null
  audioUrl?: string | null
  // capture-with-target: what this capture is about (see lib/capture-target.ts)
  targetKind?: CaptureTargetKind | null
  targetId?: string | null
}

// Hard ceiling on a single capture body. The largest live capture (an 85k-char
// paste) turned into a single giant extraction call; beyond this size the capture
// should be split by the user. Env-tunable.
export const MAX_CAPTURE_CHARS = Number(process.env.MEMO_MAX_CAPTURE_CHARS) || 100_000

// Identical-content submissions inside this window are treated as ONE capture
// (double-click / double-submit protection). captures is append-only with no
// retraction, so a duplicate insert is permanent ground truth that double-counts
// every claim; it happened twice in production before this guard.
const DEDUP_WINDOW_MS = 10 * 60 * 1000

// Writes one append-only row to `captures` using the caller's RLS-scoped client
// (so user_id must equal auth.uid()), then logs a capture telemetry event. Never
// updates or deletes (captures is append-only via the PR0 trigger).
//
// IDEMPOTENT on content: if an identical body landed for this user within the
// dedup window, the existing capture id is returned and nothing is inserted.
export async function writeCapture(
  supabase: SupabaseClient,
  userId: string,
  input: CaptureInput
): Promise<{ id: string }> {
  if (input.body.length > MAX_CAPTURE_CHARS) {
    throw new Error(
      `[capture] too large (${input.body.length.toLocaleString()} characters; the limit is ` +
        `${MAX_CAPTURE_CHARS.toLocaleString()}). Split it into smaller notes.`
    )
  }

  // Dedup: fetch the few captures from the window and compare bodies in code (an
  // eq filter on a large body would not fit in a querystring). RLS-scoped.
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString()
  const { data: recent } = await supabase
    .from('captures')
    .select('id, body')
    .eq('user_id', userId)
    .gt('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(10)
  const dup = (recent ?? []).find((r) => (r as { body: string | null }).body === input.body)
  if (dup) {
    await logEvent({
      user_id: userId,
      event_type: 'capture',
      name: 'duplicate_ignored',
      attrs: { mode: input.mode, modality: input.modality, existing_id: (dup as { id: string }).id },
    })
    return { id: (dup as { id: string }).id }
  }

  const { data, error } = await supabase
    .from('captures')
    .insert({
      user_id: userId,
      mode: input.mode,
      modality: input.modality,
      body: input.body,
      routing_hint: input.routingHint ?? null,
      audio_url: input.audioUrl ?? null,
      target_kind: input.targetKind ?? null,
      target_id: input.targetId ?? null,
    })
    .select('id')
    .single()
  if (error) throw new Error(`[capture] insert: ${error.message}`)

  const id = (data as { id: string }).id
  await logEvent({
    user_id: userId,
    event_type: 'capture',
    name: input.mode,
    attrs: {
      mode: input.mode,
      modality: input.modality,
      routing_hint: input.routingHint ?? null,
      target_kind: input.targetKind ?? null,
      target_id: input.targetId ?? null,
    },
  })
  return { id }
}
