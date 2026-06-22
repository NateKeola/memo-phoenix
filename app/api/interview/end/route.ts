import { NextResponse, type NextRequest } from 'next/server'
import { authorizeApiUser } from '@/lib/auth/guard'
import { fetchTranscript } from '@/lib/elevenlabs'
import { logEvent } from '@/lib/telemetry'

export const runtime = 'nodejs'

// Ends an interview: fetches the authoritative transcript from ElevenLabs (with a
// client-accumulated transcript as fallback), writes ONE append-only capture
// (mode='interview') linked to the session, and marks the session ended. The
// miner picks the capture up on its next run exactly like a memo or text capture.
export async function POST(request: NextRequest) {
  const auth = await authorizeApiUser()
  if ('error' in auth) return auth.error
  const { supabase, user } = auth

  const body = (await request.json().catch(() => ({}))) as {
    sessionId?: string
    conversationId?: string
    transcript?: string
    targetKind?: string
    targetId?: string
  }
  if (!body.sessionId) return NextResponse.json({ error: 'missing sessionId' }, { status: 400 })

  // Verify the session exists and belongs to this user FIRST, so a capture only
  // ever links to a real, owned session (interview_id has no FK).
  const { data: session, error: selErr } = await supabase
    .from('interview_sessions')
    .select('id')
    .eq('id', body.sessionId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (selErr) {
    console.error('[interview/end] session lookup:', selErr.message)
    return NextResponse.json({ error: 'session lookup failed' }, { status: 500 })
  }
  if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 })

  // Prefer the authoritative ElevenLabs transcript; fall back to the client's.
  let transcript = (body.transcript ?? '').trim()
  let source = transcript ? 'client' : 'none'
  if (body.conversationId) {
    try {
      const fetched = await fetchTranscript(body.conversationId)
      if (fetched && fetched.text.trim()) {
        transcript = fetched.text.trim()
        source = `elevenlabs:${fetched.status}`
      }
    } catch (err) {
      console.error('[interview/end] transcript fetch failed:', err)
    }
  }

  // mark the session ended (check the error so we don't proceed on a failed write)
  const { error: updErr } = await supabase
    .from('interview_sessions')
    .update({ ended_at: new Date().toISOString(), elevenlabs_conversation_id: body.conversationId ?? null })
    .eq('id', body.sessionId)
    .eq('user_id', user.id)
  if (updErr) {
    console.error('[interview/end] session update:', updErr.message)
    return NextResponse.json({ error: 'could not end session' }, { status: 500 })
  }

  // A real conversation has at least one exchange. Don't capture an empty or
  // aborted one (the transcript is "role: text" lines, so turns = non-empty lines).
  const turns = transcript.split('\n').filter((l) => l.trim()).length
  const tooShort = turns < 2 || transcript.length < 20
  if (tooShort) {
    await logEvent({
      user_id: user.id,
      event_type: 'interview_ended',
      attrs: { session_id: body.sessionId, transcript_length: transcript.length, turns, captured: false, too_short: true, source },
    })
    return NextResponse.json({ captureId: null, transcriptLength: transcript.length, captured: false })
  }

  const { data: cap, error } = await supabase
    .from('captures')
    .insert({
      user_id: user.id,
      mode: 'interview',
      modality: 'voice',
      body: transcript,
      interview_id: body.sessionId,
      // capture-with-target: a person/topic interview attaches to its target
      target_kind: body.targetKind === 'person' || body.targetKind === 'topic' ? body.targetKind : null,
      target_id: body.targetKind === 'person' && typeof body.targetId === 'string' ? body.targetId : null,
    })
    .select('id')
    .single()
  if (error) {
    console.error('[interview/end] capture insert:', error.message)
    return NextResponse.json({ error: 'could not save capture' }, { status: 500 })
  }

  await logEvent({
    user_id: user.id,
    event_type: 'interview_ended',
    attrs: { session_id: body.sessionId, transcript_length: transcript.length, turns, captured: true, source },
  })

  return NextResponse.json({
    captureId: (cap as { id: string }).id,
    transcriptLength: transcript.length,
    captured: true,
  })
}
