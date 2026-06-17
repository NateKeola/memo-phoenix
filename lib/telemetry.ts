import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'

// Telemetry sink (harness doctrine: telemetry from day one). The three required
// signals ride one loose table via `event_type`:
//   - tool_call  : a retrieval/companion tool invocation
//   - miner_run  : one row per A/B/C stage (attrs: stage, rows_in, rows_out)
//   - cache      : prompt-cache read/write (attrs: { hit: boolean })
//   - llm_call   : a model call (attrs may carry { hit })
//   - error      : a failure
// event_type is intentionally untyped in the DB so new kinds need no migration.
export type TelemetryEvent = {
  // Service-role writes have no auth.uid(), so user_id is stamped explicitly.
  user_id: string
  event_type: string
  name?: string
  duration_ms?: number
  attrs?: Record<string, unknown>
}

// Fire-and-forget. Writes via the service-role client (telemetry is server-only)
// and never throws into the caller's path.
export async function logEvent(event: TelemetryEvent): Promise<void> {
  try {
    const admin = createAdminClient()
    const { error } = await admin.from('telemetry_events').insert({
      user_id: event.user_id,
      event_type: event.event_type,
      name: event.name ?? null,
      duration_ms: event.duration_ms ?? null,
      attrs: event.attrs ?? {},
    })
    if (error) {
      console.error('[telemetry] insert failed:', error.message)
    }
  } catch (err) {
    console.error('[telemetry] logEvent threw:', err)
  }
}
