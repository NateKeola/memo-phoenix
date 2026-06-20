import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { composeBrief, composePersonBrief, composeTopicBrief, type Brief } from '@/lib/interview/briefing'
import {
  composeSystemPrompt,
  composeOnboardingSystemPrompt,
  firstMessage,
  type InterviewMode,
} from '@/lib/interview/compose'
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
  // Onboarding (first-run) is its own mode: a warm, broad first life overview with
  // no brief (the graph is empty), using the isolated onboarding bible.
  const isOnboarding = body.mode === 'onboarding'
  let mode: InterviewMode = isOnboarding ? 'onboarding' : body.mode === 'daily' ? 'daily' : 'open'

  // The brief is the injection seed. A daily interview scans the graph; a targeted
  // interview (capture-with-target) seeds the same DAILY_BRIEF slot with a specific
  // person or chat topic, so the conversation aims at building context on it.
  let brief: Brief = { items: [], text: '', itemCount: 0, resurfacingStub: false, reconfirmCount: 0 }
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
  const effectiveMode: InterviewMode = isOnboarding
    ? 'onboarding'
    : mode === 'daily' && hasBrief
      ? 'daily'
      : 'open'

  const now = new Date()
  const userName = process.env.MEMO_USER_NAME || user.email?.split('@')[0] || 'there'
  const systemPrompt = isOnboarding
    ? composeOnboardingSystemPrompt({ userName, now })
    : composeSystemPrompt({ userName, brief: brief.text, now })
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
      reconfirm_count: brief.reconfirmCount,
      degraded: mode === 'daily' && !hasBrief,
      brief_error: briefError,
      target_kind: targetKind,
      target_id: targetId,
    },
  })

  // The freshness loop is visible in telemetry: which aging nodes were folded into
  // the interview as "is this still true?" checks (the renew/supersede outcome is
  // logged miner-side as the `freshness` event on the next mine).
  if (brief.reconfirmCount > 0) {
    await logEvent({
      user_id: user.id,
      event_type: 'reconfirm_surfaced',
      name: 'daily',
      attrs: {
        count: brief.reconfirmCount,
        labels: brief.items.filter((i) => i.kind === 'reconfirm').map((i) => i.label),
      },
    })
  }

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
