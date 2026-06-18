import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/telemetry'

export type CaptureMode = 'text' | 'memo' | 'interview'
export type CaptureModality = 'text' | 'voice'

export type CaptureInput = {
  mode: CaptureMode
  modality: CaptureModality
  body: string
  routingHint?: string | null
  audioUrl?: string | null
}

// Writes one append-only row to `captures` using the caller's RLS-scoped client
// (so user_id must equal auth.uid()), then logs a capture telemetry event. Never
// updates or deletes (captures is append-only via the PR0 trigger).
export async function writeCapture(
  supabase: SupabaseClient,
  userId: string,
  input: CaptureInput
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('captures')
    .insert({
      user_id: userId,
      mode: input.mode,
      modality: input.modality,
      body: input.body,
      routing_hint: input.routingHint ?? null,
      audio_url: input.audioUrl ?? null,
    })
    .select('id')
    .single()
  if (error) throw new Error(`[capture] insert: ${error.message}`)

  const id = (data as { id: string }).id
  await logEvent({
    user_id: userId,
    event_type: 'capture',
    name: input.mode,
    attrs: { mode: input.mode, modality: input.modality, routing_hint: input.routingHint ?? null },
  })
  return { id }
}
