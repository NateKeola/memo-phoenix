// Shared microphone acquisition for the voice surfaces (memo capture + the two
// interview widgets). Before this, each surface called
// `navigator.mediaDevices.getUserMedia` directly, which fails in ways the old code
// could not explain:
//
//  - In an EMBEDDED / in-app browser (opening the app from an email or text link on
//    a phone: Gmail, Messages, Slack, iOS Mail all use a WebView) `mediaDevices` is
//    often UNDEFINED, so `navigator.mediaDevices.getUserMedia` throws an opaque
//    "Cannot read properties of undefined". This is the classic "the mic does not
//    work across several of my devices" report for a link-shared beta app.
//  - In a NON-SECURE context (plain http, not localhost) `mediaDevices` is likewise
//    undefined.
//  - The memo surface collapsed EVERY getUserMedia rejection into one generic
//    "permission denied or unavailable" string, hiding the real cause.
//
// This module centralizes a preflight (secure context + API presence) and maps each
// getUserMedia DOMException to a clear, actionable message, so a failure names its
// cause instead of failing silently.

// Why the browser cannot do microphone capture AT ALL in this context (independent
// of any permission prompt). Returns null when the environment is capable and the
// caller should proceed to acquireMic(). Only meaningful in the browser.
export function micUnavailableReason(): string | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'Microphone capture is only available in the browser.'
  }
  // A secure context is required for getUserMedia (https, or localhost in dev).
  if (window.isSecureContext === false) {
    return 'This page is not served securely, so the browser blocks microphone access. Open the app over https.'
  }
  // The usual in-app-browser / embedded-WebView case: the whole API is missing.
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return (
      'Your browser will not give this app the microphone. If you opened this from a link inside ' +
      'another app (email, messages, Slack), open it directly in Safari or Chrome and try again.'
    )
  }
  return null
}

// Map a getUserMedia rejection to a clear, user-facing message. Exported (pure) so
// the mapping is testable and reused by every surface.
export function describeMicError(err: unknown): string {
  const name = (err as { name?: string })?.name
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was blocked. Allow the mic for this site in your browser settings, then try again.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Connect or enable a microphone and try again.'
    case 'NotReadableError':
      return 'The microphone is in use by another app or tab. Close anything else using it and try again.'
    case 'AbortError':
      return 'The microphone could not start. Try again.'
    default: {
      const msg = err instanceof Error ? err.message : String(err)
      return `Microphone unavailable: ${msg}`
    }
  }
}

// Acquire a microphone stream, throwing an Error whose message is safe to show the
// user. The caller owns the returned stream and MUST stop its tracks when done
// (memo records with it then stops it; the interview widgets use it only to confirm
// permission and stop it immediately so the ElevenLabs SDK can own the device).
export async function acquireMic(): Promise<MediaStream> {
  const reason = micUnavailableReason()
  if (reason) throw new Error(reason)
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    throw new Error(describeMicError(err))
  }
}

// Stop every track on a stream (release the device). Safe on null/undefined.
export function releaseStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop())
}
