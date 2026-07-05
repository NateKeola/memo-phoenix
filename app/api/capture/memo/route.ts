import { NextResponse, type NextRequest } from 'next/server'
import { authorizeApiUser } from '@/lib/auth/guard'
import { writeCapture } from '@/lib/captures'
import { transcribe } from '@/lib/stt'
import { parseTarget } from '@/lib/capture-target'
import { logEvent } from '@/lib/telemetry'
import { logObs, obsError } from '@/lib/observability'

// Server-side: the ElevenLabs key never leaves this route. Receives the raw
// recorded audio as the request body, transcribes via Scribe, writes an
// append-only memo capture, and returns the transcript.
//
// Observability: this is the path that had NO diagnostics panel, so a memo failure
// on another device/user was invisible. It now records the Scribe transcript step
// and the capture write to the durable layer (STATUS + timings + byte/char COUNTS
// only, never the audio or the transcript text).
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const auth = await authorizeApiUser()
  if ('error' in auth) return auth.error
  const { supabase, user } = auth

  const contentType = request.headers.get('content-type') || 'audio/webm'
  const audio = Buffer.from(await request.arrayBuffer())
  if (audio.length === 0) {
    await logObs({ subsystem: 'capture_memo', event: 'empty_audio', level: 'warn', status: 'rejected', userId: user.id, meta: { bytes: 0 } })
    return NextResponse.json({ error: 'empty audio' }, { status: 400 })
  }

  let text: string
  const t0 = Date.now()
  try {
    text = (await transcribe(audio, contentType)).text
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[capture/memo] transcription failed:', message)
    await logObs({
      subsystem: 'scribe',
      event: 'transcribe_error',
      status: 'error',
      userId: user.id,
      durationMs: Date.now() - t0,
      ...obsError(err),
      meta: { bytes: audio.length, contentType },
    })
    return NextResponse.json({ error: 'transcription failed' }, { status: 502 })
  }
  await logObs({
    subsystem: 'scribe',
    event: 'transcribe_ok',
    status: 'ok',
    userId: user.id,
    durationMs: Date.now() - t0,
    meta: { bytes: audio.length, chars: text.length, contentType },
  })

  if (!text.trim()) {
    await logObs({ subsystem: 'scribe', event: 'no_speech', level: 'warn', status: 'empty', userId: user.id, meta: { bytes: audio.length } })
    return NextResponse.json({ error: 'no speech detected' }, { status: 422 })
  }

  // capture-with-target: an "add memo about this" surface passes the target as
  // query params (?target_kind=person&target_id=...).
  const url = new URL(request.url)
  const target = parseTarget(url.searchParams.get('target_kind'), url.searchParams.get('target_id'))
  const source = url.searchParams.get('source')

  let id: string
  try {
    ;({ id } = await writeCapture(supabase, user.id, {
      mode: 'memo',
      modality: 'voice',
      body: text,
      targetKind: target?.kind ?? null,
      targetId: target?.id ?? null,
      // audio file retention (audio_url) is deferred; V0 keeps the transcript only.
    }))
  } catch (err) {
    await logObs({ subsystem: 'capture_memo', event: 'error', status: 'error', userId: user.id, ...obsError(err), meta: { chars: text.length } })
    return NextResponse.json({ error: 'could not save the memo' }, { status: 500 })
  }
  await logObs({
    subsystem: 'capture_memo',
    event: 'ok',
    status: 'ok',
    userId: user.id,
    meta: { chars: text.length, target_kind: target?.kind ?? null },
  })
  if (target) {
    await logEvent({
      user_id: user.id,
      event_type: 'context_add',
      name: 'memo',
      attrs: { source, target_kind: target.kind, target_id: target.id ?? null },
    })
  }
  return NextResponse.json({ id, transcript: text })
}
