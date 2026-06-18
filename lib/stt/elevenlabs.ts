import 'server-only'
import type { SttProvider } from './types'

// ElevenLabs Scribe speech-to-text. Server-only: the ELEVENLABS_API_KEY must
// never reach the browser. Raw multipart POST (no SDK dependency).
const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text'

export const elevenLabsScribe: SttProvider = {
  async transcribe(audio, contentType) {
    const apiKey = process.env.ELEVENLABS_API_KEY
    if (!apiKey) throw new Error('[stt] ELEVENLABS_API_KEY is not set')
    const model = process.env.ELEVENLABS_STT_MODEL || 'scribe_v1'

    const form = new FormData()
    form.append('model_id', model)
    form.append('file', new Blob([new Uint8Array(audio)], { type: contentType }), filenameFor(contentType))

    // Do not set Content-Type by hand; fetch adds the multipart boundary.
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`[stt] ElevenLabs ${res.status}: ${detail.slice(0, 300)}`)
    }
    const json = (await res.json()) as { text?: string }
    return { text: json.text ?? '' }
  },
}

function filenameFor(ct: string): string {
  if (ct.includes('webm')) return 'audio.webm'
  if (ct.includes('ogg')) return 'audio.ogg'
  if (ct.includes('mp4') || ct.includes('m4a')) return 'audio.mp4'
  if (ct.includes('wav')) return 'audio.wav'
  if (ct.includes('mpeg') || ct.includes('mp3')) return 'audio.mp3'
  return 'audio.bin'
}
