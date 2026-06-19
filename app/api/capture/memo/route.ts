import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { writeCapture } from '@/lib/captures'
import { transcribe } from '@/lib/stt'
import { parseTarget } from '@/lib/capture-target'
import { logEvent } from '@/lib/telemetry'

// Server-side: the ElevenLabs key never leaves this route. Receives the raw
// recorded audio as the request body, transcribes via Scribe, writes an
// append-only memo capture, and returns the transcript.
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const contentType = request.headers.get('content-type') || 'audio/webm'
  const audio = Buffer.from(await request.arrayBuffer())
  if (audio.length === 0) return NextResponse.json({ error: 'empty audio' }, { status: 400 })

  let text: string
  try {
    text = (await transcribe(audio, contentType)).text
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[capture/memo] transcription failed:', message)
    return NextResponse.json({ error: 'transcription failed' }, { status: 502 })
  }

  if (!text.trim()) {
    return NextResponse.json({ error: 'no speech detected' }, { status: 422 })
  }

  // capture-with-target: an "add memo about this" surface passes the target as
  // query params (?target_kind=person&target_id=...).
  const url = new URL(request.url)
  const target = parseTarget(url.searchParams.get('target_kind'), url.searchParams.get('target_id'))
  const source = url.searchParams.get('source')

  const { id } = await writeCapture(supabase, user.id, {
    mode: 'memo',
    modality: 'voice',
    body: text,
    targetKind: target?.kind ?? null,
    targetId: target?.id ?? null,
    // audio file retention (audio_url) is deferred; V0 keeps the transcript only.
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
