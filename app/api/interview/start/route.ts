import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { composeBrief, composePersonBrief, composeTopicBrief, type Brief } from '@/lib/interview/briefing'
import { composeSystemPrompt, firstMessage } from '@/lib/interview/compose'
import { getSignedUrl } from '@/lib/elevenlabs'
import { logEvent } from '@/lib/telemetry'

export const runtime = 'nodejs'

// Starts an interview: composes the per-session system prompt (bible for open,
// bible + deterministic brief for daily), records the session, and mints a signed
// URL. The client connects with the signed URL and applies the system prompt +
// first message as conversation_config_override.
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as {
    mode?: string
    target?: { kind?: string; id?: string; seed?: string }
  }
  const target = body.target
  let mode: 'open' | 'daily' = body.mode === 'daily' ? 'daily' : 'open'

  // The brief is the injection seed. A daily interview scans the graph; a targeted
  // interview (capture-with-target) seeds the same DAILY_BRIEF slot with a specific
  // person or chat topic, so the conversation aims at building context on it.
  let brief: Brief = { items: [], text: '', itemCount: 0, resurfacingStub: false }
  let briefError = false
  let targetKind: 'person' | 'topic' | null = null
  let targetId: string | null = null

  if (target?.kind === 'person' && typeof target.id === 'string' && target.id.trim()) {
    targetKind = 'person'
    targetId = target.id.trim()
    mode = 'daily'
    try {
      brief = await composePersonBrief(supabase, user.id, targetId)
    } catch (err) {
      console.error('[interview/start] person brief failed:', err)
      briefError = true
    }
  } else if (target?.kind === 'topic' && typeof target.seed === 'string' && target.seed.trim()) {
    targetKind = 'topic'
    mode = 'daily'
    brief = composeTopicBrief(target.seed)
  } else if (mode === 'daily') {
    try {
      brief = await composeBrief(supabase)
    } catch (err) {
      console.error('[interview/start] briefing failed:', err)
      briefError = true
    }
  }

  // Daily mode "degrades" to open behavior when there is nothing to surface (thin
  // graph or a briefing error): the bible reads an empty brief as open mode, so
  // the first message must match the EFFECTIVE mode, not just the requested one.
  const hasBrief = brief.text.trim().length > 0
  const effectiveMode: 'open' | 'daily' = mode === 'daily' && hasBrief ? 'daily' : 'open'

  const userName = process.env.MEMO_USER_NAME || user.email?.split('@')[0] || 'there'
  const systemPrompt = composeSystemPrompt({ userName, brief: brief.text, now: new Date() })
  const first = firstMessage(effectiveMode)

  // For daily mode store the brief object even when empty, so the record is never
  // an ambiguous mode='daily' + brief=null; null is reserved for open mode.
  const briefRecord = mode === 'daily' ? { ...brief, error: briefError } : null
  const { data: sessionRow, error: sErr } = await supabase
    .from('interview_sessions')
    .insert({ user_id: user.id, mode, brief: briefRecord })
    .select('id')
    .single()
  if (sErr) {
    console.error('[interview/start] session insert:', sErr.message)
    return NextResponse.json({ error: 'could not create session' }, { status: 500 })
  }
  const sessionId = (sessionRow as { id: string }).id

  let signedUrl: string
  try {
    signedUrl = await getSignedUrl()
  } catch (err) {
    console.error('[interview/start] signed url:', err)
    return NextResponse.json({ error: 'could not start interview (ElevenLabs)' }, { status: 502 })
  }

  await logEvent({
    user_id: user.id,
    event_type: 'interview_started',
    name: mode,
    attrs: {
      mode,
      effective_mode: effectiveMode,
      brief_item_count: brief.itemCount,
      degraded: mode === 'daily' && !hasBrief,
      brief_error: briefError,
      target_kind: targetKind,
      target_id: targetId,
    },
  })

  // systemPrompt (bible + the user's own brief) is returned to the user's own
  // browser, which applies it to ElevenLabs via conversation_config_override (the
  // SDK applies overrides client-side). It is the user's own data, and the brief
  // must reach ElevenLabs regardless for the agent to use it; it crosses no
  // tenancy boundary.
  return NextResponse.json({
    sessionId,
    mode,
    signedUrl,
    systemPrompt,
    firstMessage: first,
    briefItemCount: brief.itemCount,
    // echoed back so the client carries the target into the end-of-session capture
    targetKind,
    targetId,
  })
}
