'use client'

import { useRouter } from 'next/navigation'
import { ConversationProvider, useConversation } from '@elevenlabs/react'
import { useCallback, useEffect, useRef, useState } from 'react'

type Phase = 'intro' | 'connecting' | 'live' | 'closing' | 'saving' | 'error'
type Line = { role: string; text: string }

// The first-run onboarding interview. Reuses the existing interview agent and the
// open-mode mechanism (signed URL + conversation_config_override) via the same
// /api/interview/start and /api/interview/end routes, but in mode='onboarding'
// (the intro bible).
//
// The interview never auto-ends: it runs until the user chooses to stop. When they
// press "Ready to end the interview?", the agent is cued to deliver its warm
// closing recap (the bible instructs this), it SPEAKS the close, and only then does
// the session tear down. After that the user lands on the "Building your initial
// context" screen, which mines their first conversation in front of them so the app
// is already populated on first view.
export function OnboardingInterview() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <p>Loading...</p>
  return (
    <ConversationProvider>
      <Inner />
    </ConversationProvider>
  )
}

// How long the agent's spoken closing must be silent before we consider it finished
// and tear down (so the goodbye is never cut off; long enough to bridge the gap
// between the agent's current turn and its closing turn), and a hard backstop so
// the user is never stuck if the close never plays at all.
const CLOSE_SILENCE_MS = 3500
const CLOSE_HARD_TIMEOUT_MS = 18000

// Onboarding length pacing. The bible aims the agent at about ten minutes; the flow
// backs that with a SOFT wrap-up nudge (cue the warm close if still live) and a HARD
// backstop that ends the session to bound runaway length and voice cost. The user
// can always end early via "Ready to end the interview?".
const SOFT_WRAP_MS = 10 * 60 * 1000
const HARD_END_MS = 15 * 60 * 1000

function Inner() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('intro')
  const [error, setError] = useState('')
  const [lines, setLines] = useState<Line[]>([])

  const sessionIdRef = useRef<string | null>(null)
  const convIdRef = useRef<string | null>(null)
  const linesRef = useRef<Line[]>([])
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // closing-flow refs
  const endingRef = useRef(false)
  const heardCloseRef = useRef(false)
  // length-pacing refs (the soft wrap + hard backstop, set once when live)
  const phaseRef = useRef<Phase>('intro')
  const sessionSoftRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionHardRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionTimersStartedRef = useRef(false)
  phaseRef.current = phase

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (sessionSoftRef.current) clearTimeout(sessionSoftRef.current)
      if (sessionHardRef.current) clearTimeout(sessionHardRef.current)
    },
    []
  )

  const conversation = useConversation({
    onConnect: (props: { conversationId?: string }) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (props?.conversationId) convIdRef.current = props.conversationId
      setPhase('live')
    },
    onDisconnect: () => {
      // The end controls drive the save flow.
    },
    onMessage: (m: unknown) => {
      const obj = (m ?? {}) as { message?: string; source?: string; role?: string }
      const text = typeof m === 'string' ? m : obj.message
      if (!text) return
      const role = String(obj.role ?? obj.source ?? 'agent')
      linesRef.current = [...linesRef.current, { role, text: String(text) }]
      setLines(linesRef.current)
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    },
  })

  const start = useCallback(async () => {
    setError('')
    setPhase('connecting')
    linesRef.current = []
    setLines([])
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      setPhase((p) => (p === 'connecting' ? 'error' : p))
      setError(
        (prev) =>
          prev ||
          "Connection timed out. If this keeps happening, confirm the agent's override toggles (System prompt, First message) are enabled in the ElevenLabs dashboard (Security)."
      )
    }, 20000)
    try {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (e) {
        const name = (e as DOMException)?.name
        throw new Error(
          name === 'NotAllowedError'
            ? 'Microphone access denied. Enable the mic in your browser settings and try again.'
            : `Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`
        )
      }
      const res = await fetch('/api/interview/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'onboarding' }),
      })
      const cfg = (await res.json()) as {
        sessionId?: string
        signedUrl?: string
        systemPrompt?: string
        firstMessage?: string
        error?: string
      }
      if (!res.ok || !cfg.signedUrl) throw new Error(cfg.error || 'could not start onboarding')
      sessionIdRef.current = cfg.sessionId ?? null
      try {
        await conversation.startSession({
          signedUrl: cfg.signedUrl,
          connectionType: 'websocket',
          overrides: {
            agent: {
              prompt: { prompt: cfg.systemPrompt ?? '' },
              firstMessage: cfg.firstMessage ?? '',
            },
          },
        })
      } catch (e) {
        throw new Error(
          `Could not start the conversation (${e instanceof Error ? e.message : String(e)}). If this mentions overrides, enable the agent's "System prompt" and "First message" override toggles in the ElevenLabs dashboard (Security).`
        )
      }
    } catch (e) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [conversation])

  // Tear down + save + complete + hand off to the build screen. Guarded so the
  // auto-end timer and the explicit "End now" button cannot both fire it.
  const finalizeEnd = useCallback(async () => {
    if (endingRef.current) return
    endingRef.current = true
    if (sessionSoftRef.current) clearTimeout(sessionSoftRef.current)
    if (sessionHardRef.current) clearTimeout(sessionHardRef.current)
    setPhase('saving')
    try {
      await conversation.endSession()
    } catch {
      // ignore; we still try to save
    }
    try {
      const endRes = await fetch('/api/interview/end', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          conversationId: convIdRef.current,
          transcript: linesRef.current.map((l) => `${l.role}: ${l.text}`).join('\n'),
        }),
      })
      if (!endRes.ok) {
        const j = (await endRes.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error || 'could not save the conversation')
      }
      const compRes = await fetch('/api/onboarding/complete', { method: 'POST' })
      if (!compRes.ok) {
        const j = (await compRes.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error || 'could not complete onboarding')
      }
      // hand off to the "Building your initial context" screen for the onboarding mine
      router.push('/building?from=onboarding')
    } catch (e) {
      endingRef.current = false
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [conversation, router])

  // The user chooses to end. We do NOT tear down yet: we cue the agent to give its
  // closing recap (the bible already instructs a warm, named recap on close) and let
  // it SPEAK. The session ends once the close finishes (auto-detected below) or when
  // the user presses "End now".
  const beginClose = useCallback(() => {
    heardCloseRef.current = false
    setPhase('closing')
    try {
      conversation.sendUserMessage("I think I'm ready to wrap up for now. Thank you, this was really nice.")
    } catch {
      // if the cue cannot be sent, the user can still press "End now"
    }
  }, [conversation])

  // Length pacing: when the interview goes live, set a SOFT wrap-up nudge (~10 min,
  // cue the warm close if still live) and a HARD backstop (~15 min, end regardless).
  // Set ONCE; they persist across the live -> closing transition. The user can still
  // end early via "Ready to end the interview?".
  useEffect(() => {
    if (phase !== 'live' || sessionTimersStartedRef.current) return
    sessionTimersStartedRef.current = true
    sessionSoftRef.current = setTimeout(() => {
      if (phaseRef.current === 'live') beginClose()
    }, SOFT_WRAP_MS)
    sessionHardRef.current = setTimeout(() => void finalizeEnd(), HARD_END_MS)
  }, [phase, beginClose, finalizeEnd])

  // Auto-end once the agent's closing has played: wait for it to speak, then for a
  // short silence, then finalize. Resets the silence timer whenever it resumes.
  useEffect(() => {
    if (phase !== 'closing') return
    if (conversation.isSpeaking) {
      heardCloseRef.current = true
      return
    }
    if (!heardCloseRef.current) return
    const t = setTimeout(() => void finalizeEnd(), CLOSE_SILENCE_MS)
    return () => clearTimeout(t)
  }, [phase, conversation.isSpeaking, finalizeEnd])

  // Hard backstop: never leave the user stuck in 'closing' if the close never plays.
  // Only fires when the agent never began speaking; if a close IS underway, the
  // silence detector above ends it naturally so a longer goodbye is not cut off.
  useEffect(() => {
    if (phase !== 'closing') return
    const t = setTimeout(() => {
      if (!heardCloseRef.current) void finalizeEnd()
    }, CLOSE_HARD_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [phase, finalizeEnd])

  return (
    <div>
      {phase === 'intro' ? (
        <div style={{ display: 'grid', gap: 12, maxWidth: 460 }}>
          <p>
            When you are ready, start the conversation. Aim for about ten minutes (enough for Memo to
            get a good first picture); there are no wrong answers. Memo will gently steer toward a
            warm goodbye around then, or you can press <em>Ready to end the interview?</em> whenever
            you feel done, and it will build your memory.
          </p>
          <button type="button" onClick={start}>
            Start the conversation
          </button>
        </div>
      ) : null}

      {phase === 'connecting' ? <p>Connecting...</p> : null}

      {phase === 'live' ? (
        <div>
          <p>Live. {conversation.isSpeaking ? 'Memo is speaking...' : 'Listening...'}</p>
          <p style={{ color: '#888', fontSize: 13 }}>Memo will gently wrap up around ten minutes, or end whenever you are ready.</p>
          <button type="button" onClick={beginClose}>
            Ready to end the interview?
          </button>
        </div>
      ) : null}

      {phase === 'closing' ? (
        <div style={{ display: 'grid', gap: 8, maxWidth: 460 }}>
          <p>Memo is wrapping up{conversation.isSpeaking ? ' and saying goodbye...' : '...'}</p>
          <p style={{ color: '#888', fontSize: 13 }}>
            It will finish its goodbye and then start building your memory. You can end now if you
            prefer.
          </p>
          <div>
            <button type="button" onClick={() => void finalizeEnd()}>
              End now
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'saving' ? <p>Saving your conversation...</p> : null}

      {phase === 'error' ? (
        <div style={{ display: 'grid', gap: 8, maxWidth: 460 }}>
          <p style={{ color: 'crimson' }}>{error}</p>
          <button type="button" onClick={() => setPhase('intro')}>
            Try again
          </button>
        </div>
      ) : null}

      {lines.length > 0 ? (
        <div style={{ marginTop: 16, maxHeight: 320, overflowY: 'auto', background: '#f5f5f5', padding: 12 }}>
          {lines.map((l, i) => (
            <p key={i} style={{ margin: '4px 0' }}>
              <strong>{l.role}:</strong> {l.text}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
