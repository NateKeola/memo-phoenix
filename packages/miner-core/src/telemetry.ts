import { admin } from './supabase'

// Writes to the PR0 telemetry_events sink. Fire-and-forget; never throws into the
// caller's path. The service-role client has no auth.uid(), so user_id is passed
// explicitly.
export async function logEvent(event: {
  user_id: string
  event_type: string // 'miner_run' | 'llm_call' | 'cache' | 'error'
  name?: string
  duration_ms?: number
  attrs?: Record<string, unknown>
}): Promise<void> {
  try {
    const { error } = await admin()
      .from('telemetry_events')
      .insert({
        user_id: event.user_id,
        event_type: event.event_type,
        name: event.name ?? null,
        duration_ms: event.duration_ms ?? null,
        attrs: event.attrs ?? {},
      })
    if (error) console.error('[miner] telemetry insert failed:', error.message)
  } catch (err) {
    console.error('[miner] telemetry threw:', err)
  }
}
