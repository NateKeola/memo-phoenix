'use client'

import { useRouter } from 'next/navigation'
import { ConversationProvider, useConversation } from '@elevenlabs/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BrandSeed } from '@/components/brand-seed'
import {
  DebugReadout,
  describeDisconnect,
  diagnosticCallbacks,
  newVadState,
  useInterviewDebug,
  useLiveStatus,
} from '@/components/interview-debug'
import { acquireMic, releaseStream, describeMicError } from '@/lib/media/mic'

type Phase = 'intro' | 'connecting' | 'live' | 'closing' | 'saving' | 'error' | 'not-captured'
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
  if (!mounted) return <p className="mp-sub">Loading...</p>
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
  // latest finalizeEnd, so the (register-once) conversation callbacks can call it
  const finalizeEndRef = useRef<null | (() => Promise<void>)>(null)
  // live browser mic stream, kept for the session so the diagnostics meter runs
  // alongside the SDK; released in finalizeEnd / error / unmount.
  const micStreamRef = useRef<MediaStream | null>(null)
  // Clear the pacing timers AND re-allow arming. Without this a retried session
  // inherited the first session's clocks: the soft timer could wrap a fresh
  // conversation minutes in, or a retry ran with no pacing at all.
  const resetPacing = () => {
    if (sessionSoftRef.current) clearTimeout(sessionSoftRef.current)
    if (sessionHardRef.current) clearTimeout(sessionHardRef.current)
    sessionTimersStartedRef.current = false
  }
  // length-pacing refs (the soft wrap + hard backstop, set once when live)
  const phaseRef = useRef<Phase>('intro')
  const sessionSoftRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionHardRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionTimersStartedRef = useRef(false)
  phaseRef.current = phase

  // --- temporary beta instrumentation (interview-end investigation) ---
  const { lines: dbgLines, log } = useInterviewDebug('onboarding')
  const vadRef = useRef(newVadState())
  // Mount/unmount of the live conversation widget: if the agent stops because this
  // component is being torn down, "widget UNMOUNTING" logs right before the disconnect.
  useEffect(() => {
    log('widget mounted')
    return () => log('widget UNMOUNTING')
  }, [log])
  useEffect(() => {
    log(`phase -> ${phase}`)
  }, [phase, log])
  // ---

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (sessionSoftRef.current) clearTimeout(sessionSoftRef.current)
      if (sessionHardRef.current) clearTimeout(sessionHardRef.current)
      releaseStream(micStreamRef.current)
      micStreamRef.current = null
    },
    []
  )

  const conversation = useConversation({
    ...diagnosticCallbacks(log, vadRef),
    onConnect: (props: { conversationId?: string }) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (props?.conversationId) convIdRef.current = props.conversationId
      log(`onConnect conversationId=${props?.conversationId ?? '?'}`)
      setPhase('live')
    },
    onDisconnect: (details: unknown) => {
      log(`onDisconnect ${describeDisconnect(details)}`)
      // React to a disconnect we did not initiate. Before this, the UI kept showing
      // "Listening..." against a dead socket indefinitely (the known
      // ends-after-greeting failure), and the user talked into nothing.
      if (endingRef.current) return // our own teardown; the save flow is driving
      const p = phaseRef.current
      if (p === 'closing') {
        // the agent hung up after its goodbye: proceed to save what we have
        void finalizeEndRef.current?.()
        return
      }
      if (p === 'live' || p === 'connecting') {
        resetPacing()
        setError(
          'The connection ended unexpectedly. Nothing is lost if you barely started; press ' +
            '"Try again" to reconnect, or skip for now and set Memo up later.'
        )
        setPhase('error')
      }
    },
    onMessage: (m: unknown) => {
      const obj = (m ?? {}) as { message?: string; source?: string; role?: string }
      const text = typeof m === 'string' ? m : obj.message
      if (!text) return
      const role = String(obj.role ?? obj.source ?? 'agent')
      log(`message [${role}] ${String(text).slice(0, 60)}`)
      linesRef.current = [...linesRef.current, { role, text: String(text) }]
      setLines(linesRef.current)
    },
    onError: (e: unknown) => {
      log(`onError ${e instanceof Error ? e.message : String(e)}`)
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    },
  })

  const liveStatus = useLiveStatus(
    conversation,
    phase === 'connecting' || phase === 'live' || phase === 'closing',
    log,
    vadRef
  )

  // Defensive: ensure the SDK mic is UNMUTED once connected (see interview-widget).
  const unmutedRef = useRef(false)
  useEffect(() => {
    const c = conversation as { status?: string; setMuted?: (m: boolean) => void }
    if (c.status === 'connected' && !unmutedRef.current) {
      unmutedRef.current = true
      try {
        c.setMuted?.(false)
        log('ensured SDK mic unmuted on connect')
      } catch {
        /* setMuted may be unavailable */
      }
    }
    if (c.status !== 'connected') unmutedRef.current = false
  }, [conversation, log])

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
        // KEEP the stream alive for the session so the browser-level meter runs
        // alongside the SDK's own capture (Chrome allows concurrent getUserMedia);
        // this separates "browser gets no audio" from "SDK gets no audio". acquireMic
        // also reports an in-app browser / insecure context clearly. Released in
        // finalizeEnd / the error path / unmount.
        const stream = await acquireMic()
        const t = stream.getAudioTracks()[0]
        log(`mic permission granted: tracks=${stream.getAudioTracks().length} state=${t?.readyState} enabled=${t?.enabled} muted=${t?.muted}`)
        micStreamRef.current = stream
      } catch (e) {
        log(`getUserMedia failed: ${e instanceof Error ? e.message : String(e)}`)
        throw e instanceof Error ? e : new Error(describeMicError(e))
      }
      log('POST /api/interview/start (onboarding)')
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
        log(`startSession() (promptLen=${(cfg.systemPrompt ?? '').length} firstMsgLen=${(cfg.firstMessage ?? '').length})`)
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
        log('startSession() resolved')
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
  }, [conversation, log])

  // Tear down + save + complete + hand off to the build screen. Guarded so the
  // auto-end timer and the explicit "End now" button cannot both fire it.
  const finalizeEnd = useCallback(async () => {
    if (endingRef.current) return
    endingRef.current = true
    log('finalizeEnd() -> endSession() (tear down + save)')
    if (sessionSoftRef.current) clearTimeout(sessionSoftRef.current)
    if (sessionHardRef.current) clearTimeout(sessionHardRef.current)
    setPhase('saving')
    try {
      await conversation.endSession()
    } catch {
      // ignore; we still try to save
    }
    releaseStream(micStreamRef.current)
    micStreamRef.current = null
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
      const endJson = (await endRes.json().catch(() => ({}))) as { captured?: boolean }
      if (endJson.captured === false) {
        // The conversation was too short to capture. Do NOT silently complete
        // onboarding over an empty capture (the old behavior dropped the user into
        // an empty app believing Memo heard them): say so, and let them retry or
        // deliberately skip.
        endingRef.current = false
        setPhase('not-captured')
        return
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
  }, [conversation, router, log])
  finalizeEndRef.current = finalizeEnd

  // Deliberate escape hatch: onboarding must never trap a user. If the voice agent
  // fails for them (mic, network, the known cutoff bug), they can skip, get into
  // the app, and do the intro interview later from /capture/interview. Marks
  // onboarding complete (skipped=true for telemetry) and goes home.
  const skip = useCallback(async () => {
    try {
      const res = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skipped: true }),
      })
      if (!res.ok) {
        // A silent failure would bounce them straight back here via the middleware
        // gate with zero feedback; say what happened instead.
        setError('Could not skip right now (the server rejected it). Try again in a moment.')
        setPhase('error')
        return
      }
    } catch {
      setError('Could not skip right now (network problem). Try again in a moment.')
      setPhase('error')
      return
    }
    router.push('/')
  }, [router])

  // The user chooses to end. We do NOT tear down yet: we cue the agent to give its
  // closing recap (the bible already instructs a warm, named recap on close) and let
  // it SPEAK. The session ends once the close finishes (auto-detected below) or when
  // the user presses "End now".
  const beginClose = useCallback(() => {
    log('beginClose() -> cue agent to wrap up (phase=closing)')
    heardCloseRef.current = false
    setPhase('closing')
    try {
      conversation.sendUserMessage("I think I'm ready to wrap up for now. Thank you, this was really nice.")
    } catch {
      // if the cue cannot be sent, the user can still press "End now"
    }
  }, [conversation, log])

  // Length pacing: when the interview goes live, set a SOFT wrap-up nudge (~10 min,
  // cue the warm close if still live) and a HARD backstop (~15 min, end regardless).
  // Set ONCE; they persist across the live -> closing transition. The user can still
  // end early via "Ready to end the interview?".
  useEffect(() => {
    if (phase !== 'live' || sessionTimersStartedRef.current) return
    sessionTimersStartedRef.current = true
    log(`pacing timers armed: soft ${SOFT_WRAP_MS / 1000}s, hard ${HARD_END_MS / 1000}s`)
    sessionSoftRef.current = setTimeout(() => {
      log('SOFT pacing timer fired (10 min)')
      if (phaseRef.current === 'live') beginClose()
    }, SOFT_WRAP_MS)
    sessionHardRef.current = setTimeout(() => {
      log('HARD pacing timer fired (15 min)')
      void finalizeEnd()
    }, HARD_END_MS)
  }, [phase, beginClose, finalizeEnd, log])

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
        <div style={{ display: 'grid', gap: 14, maxWidth: 460, marginTop: 6 }}>
          <p className="mp-sub" style={{ marginTop: 0 }}>
            When you are ready, start the conversation. Aim for about ten minutes (enough for Memo to
            get a good first picture); there are no wrong answers. Memo will gently steer toward a
            warm goodbye around then, or you can press <em>Ready to end the interview?</em> whenever
            you feel done, and it will build your memory.
          </p>
          <button type="button" className="mp-btn mp-btn--primary mp-btn--block" onClick={start}>
            Start the conversation
          </button>
          <button type="button" className="mp-link" style={{ background: 'none', border: 0, cursor: 'pointer', fontSize: 14 }} onClick={() => void skip()}>
            Skip for now, I will do this later
          </button>
        </div>
      ) : null}

      {phase === 'connecting' || phase === 'live' || phase === 'closing' ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, marginTop: 24 }}>
          <BrandSeed size={208} mark={80} />
          <p className="mp-eyebrow mp-eyebrow--accent" style={{ letterSpacing: '0.22em' }}>
            {phase === 'connecting'
              ? 'Connecting...'
              : phase === 'closing'
                ? conversation.isSpeaking ? 'Saying goodbye...' : 'Wrapping up...'
                : conversation.isSpeaking ? 'Memo is speaking...' : 'Listening...'}
          </p>

          {phase === 'live' ? (
            <>
              <button type="button" className="mp-btn mp-btn--ghost" onClick={beginClose}>
                Ready to end the interview?
              </button>
              <p className="mp-meta" style={{ textAlign: 'center', maxWidth: 320 }}>
                Memo will gently wrap up around ten minutes, or end whenever you are ready.
              </p>
            </>
          ) : null}

          {phase === 'closing' ? (
            <>
              <button type="button" className="mp-btn mp-btn--ghost" onClick={() => void finalizeEnd()}>
                End now
              </button>
              <p className="mp-meta" style={{ textAlign: 'center', maxWidth: 340 }}>
                It will finish its goodbye and then start building your memory. You can end now if you prefer.
              </p>
            </>
          ) : null}
        </div>
      ) : null}

      {phase === 'saving' ? <p className="mp-sub" style={{ marginTop: 20 }}>Saving your conversation...</p> : null}

      {phase === 'error' ? (
        <div style={{ display: 'grid', gap: 10, maxWidth: 460, marginTop: 8 }}>
          <p className="mp-bad" style={{ margin: 0 }}>{error}</p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button type="button" className="mp-btn mp-btn--ghost" onClick={() => { endingRef.current = false; resetPacing(); setPhase('intro') }}>
              Try again
            </button>
            <button type="button" className="mp-link" style={{ background: 'none', border: 0, cursor: 'pointer', fontSize: 14 }} onClick={() => void skip()}>
              Skip for now
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'not-captured' ? (
        <div style={{ display: 'grid', gap: 10, maxWidth: 460, marginTop: 8 }}>
          <p className="mp-bad" style={{ margin: 0 }}>
            That conversation was too short to capture, so Memo has nothing to build from yet.
          </p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button type="button" className="mp-btn mp-btn--primary" onClick={() => { endingRef.current = false; resetPacing(); setPhase('intro') }}>
              Try the conversation again
            </button>
            <button type="button" className="mp-link" style={{ background: 'none', border: 0, cursor: 'pointer', fontSize: 14 }} onClick={() => void skip()}>
              Skip for now
            </button>
          </div>
        </div>
      ) : null}

      {lines.length > 0 ? (
        <div className="mp-card mp-card--recessed" style={{ marginTop: 18, maxHeight: 320, overflowY: 'auto' }}>
          {lines.map((l, i) => (
            <p key={i} style={{ margin: '6px 0', lineHeight: 1.45 }}>
              <strong style={{ color: 'var(--accent)', fontWeight: 500 }}>{l.role}:</strong> {l.text}
            </p>
          ))}
        </div>
      ) : null}


      <DebugReadout title="/onboarding" status={liveStatus} lines={dbgLines} />
    </div>
  )
}

