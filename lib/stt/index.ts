import 'server-only'
import type { SttProvider } from './types'
import { elevenLabsScribe } from './elevenlabs'

// The configured STT provider. Swap this one line to change providers; the
// capture UI and route never reference a specific vendor.
const provider: SttProvider = elevenLabsScribe

export function transcribe(audio: Buffer, contentType: string): Promise<{ text: string }> {
  return provider.transcribe(audio, contentType)
}

export type { SttProvider }
