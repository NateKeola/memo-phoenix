// Client-side observability reporter. The interview widgets run entirely in the
// browser (the ElevenLabs SDK is client-side), so their lifecycle signals never
// reach the server unless posted. This fire-and-forget helper sends a small,
// whitelisted event to /api/obs, which validates it and writes to the durable
// observability layer. NEVER pass user content: /api/obs keeps only whitelisted
// shaped metadata, and this sends only the shaped fields below.

export type ClientObsPayload = {
  subsystem: 'interview' | 'onboarding' | 'capture_memo' | 'surface'
  event: string
  level?: 'info' | 'warn' | 'error'
  status?: string
  errorType?: string
  errorMessage?: string
  durationMs?: number
  meta?: Record<string, string | number | boolean>
}

export function reportObs(payload: ClientObsPayload): void {
  try {
    // keepalive so a disconnect / unmount event still flushes during teardown.
    void fetch('/api/obs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* never throw into the UI */
  }
}
