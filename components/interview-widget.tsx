'use client'

import { PageHeader } from '@/components/page-header'
import { BrandSeed } from '@/components/brand-seed'
import { ConversationProvider, useConversation } from '@elevenlabs/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DebugReadout,
  describeDisconnect,
  disconnectInfo,
  diagnosticCallbacks,
  newVadState,
  useInterviewDebug,
  useLiveStatus,
} from '@/components/interview-debug'
import { acquireMic, releaseStream, describeMicError } from '@/lib/media/mic'
import { reportObs } from '@/lib/obs-client'
import { localTimeZone } from '@/lib/tz'

type Mode = 'open' | 'daily'
type Phase = 'choose' | 'connecting' | 'live' | 'saving' | 'done' | 'error'
type Line = { role: string; text: string }

// The full interview surface (ElevenLabs voice SDK). Loaded lazily by the route via
// next/dynamic so the ~125 kB SDK is a separate chunk, not in the route's initial JS.
export function InterviewWidget() {
  // The ElevenLabs SDK is browser-only; render it only after mount so it never
  // runs during SSR/prerender.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    <main className="mp-page mp-page--flush" style={{ maxWidth: 600 }}>
      <PageHeader back="/" backLabel="Home" />
      <p className="mp-eyebrow">Interview</p>
      <h1 className="mp-h1" style={{ marginTop: 8 }}>A conversation with Memo</h1>
      <p className="mp-sub">A voice conversation. It captures itself and feeds the graph on the next miner run.</p>
      {mounted ? (
        <ConversationProvider>
          <Interview />
        </ConversationProvider>
      ) : (
        <p className="mp-sub" style={{ marginTop: 16 }}>Loading...</p>
      )}
    </main>
  )
}

function Interview() {
  const [phase, setPhase] = useState<Phase>('choose')
  // for the (register-once) conversation callbacks to read the current phase and
  // whether WE initiated the teardown
  const phaseRef = useRef<Phase>('choose')
  const endingRef = useRef(false)
  // The live browser mic stream, kept for the session so the diagnostics panel meters
  // it ALONGSIDE the SDK's own capture. Released in end()/error/unmount.
  const micStreamRef = useRef<MediaStream | null>(null)
  const [mode, setMode] = useState<Mode | null>(null)
  const modeRef = useRef<Mode | null>(null)
  modeRef.current = mode
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  pausedRef.current = paused
  const [error, setError] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [result, setResult] = useState<{ captured: boolean; length: number } | null>(null)

  const sessionIdRef = useRef<string | null>(null)
  const convIdRef = useRef<string | null>(null)
  const linesRef = useRef<Line[]>([])
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // capture-with-target: a person/topic interview reads its target from the URL
  // and carries it into the end-of-session capture.
  const targetKindRef = useRef<string | null>(null)
  const targetIdRef = useRef<string | null>(null)
  const [target, setTarget] = useState<{ kind: 'person' | 'topic'; id?: string; seed?: string; label?: string } | null>(null)

  // --- temporary beta instrumentation (interview-end investigation) ---
  const { lines: dbgLines, log } = useInterviewDebug('capture')
  const vadRef = useRef(newVadState())
  // Mount/unmount of the live conversation widget: if the agent stops because this
  // component is being torn down (the remount theory), "widget UNMOUNTING" logs right
  // before the disconnect.
  useEffect(() => {
    log('widget mounted')
    return () => log('widget UNMOUNTING')
  }, [log])
  useEffect(() => {
    log(`phase -> ${phase}`)
  }, [phase, log])
  // ---

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    releaseStream(micStreamRef.current)
    micStreamRef.current = null
  }, [])

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const t = sp.get('target')
    const id = sp.get('id')
    const seed = sp.get('seed')
    if (t === 'person' && id) setTarget({ kind: 'person', id, label: sp.get('label') ?? undefined })
    else if (t === 'topic' && seed) setTarget({ kind: 'topic', seed })
  }, [])

  phaseRef.current = phase

  const conversation = useConversation({
    ...diagnosticCallbacks(log, vadRef),
    onConnect: (props: { conversationId?: string }) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (props?.conversationId) convIdRef.current = props.conversationId
      log(`onConnect conversationId=${props?.conversationId ?? '?'}`)
      setPhase('live')
      reportObs({ subsystem: 'interview', event: 'connect', meta: { mode: modeRef.current ?? 'open' } })
    },
    onDisconnect: (details: unknown) => {
      log(`onDisconnect ${describeDisconnect(details)}`)
      const info = disconnectInfo(details)
      // A disconnect we DID initiate (endingRef) is the normal save path; only an
      // unexpected one is an error-level observability signal.
      reportObs({
        subsystem: 'interview',
        event: 'disconnect',
        level: !endingRef.current && (phaseRef.current === 'live' || phaseRef.current === 'connecting') ? 'error' : 'info',
        meta: { mode: modeRef.current ?? 'open', reason: info.reason, ...(info.closeCode != null ? { closeCode: info.closeCode } : {}) },
      })
      // React to a disconnect we did not initiate: without this the UI showed
      // 'Listening...' against a dead socket indefinitely (the documented
      // ends-after-greeting failure signature). The End-button flow (endingRef)
      // still drives the save path for our own teardown.
      if (endingRef.current) return
      if (phaseRef.current === 'live' || phaseRef.current === 'connecting') {
        setError('The connection ended unexpectedly. Start again when you are ready.')
        setPhase('error')
      }
    },
    // Best-effort live captions; the authoritative transcript is fetched server-side at end.
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
      reportObs({ subsystem: 'interview', event: 'error', level: 'error', errorMessage: e instanceof Error ? e.message : String(e), meta: { mode: modeRef.current ?? 'open' } })
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    },
  })

  const liveStatus = useLiveStatus(conversation, phase === 'connecting' || phase === 'live', log, vadRef)

  // Pause: mute the SDK mic so the agent hears nothing and holds off, and show a
  // clear paused state. Resume unmutes and the conversation continues. No pacing
  // timers run in this (daily/open) surface, so pausing here only gates the mic.
  const togglePause = useCallback(() => {
    const next = !pausedRef.current
    const c = conversation as { setMuted?: (m: boolean) => void }
    try {
      c.setMuted?.(next)
      log(next ? 'paused (mic muted)' : 'resumed (mic unmuted)')
    } catch {
      /* setMuted may be unavailable */
    }
    reportObs({ subsystem: 'interview', event: next ? 'pause' : 'resume', meta: { mode: modeRef.current ?? 'open' } })
    setPaused(next)
  }, [conversation, log])

  // Defensive: ensure the SDK mic is UNMUTED once connected. If the SDK ever starts
  // muted, the agent hears nothing (greets then ends on silence); unmuting is a
  // documented no-op when already unmuted. isMuted is also shown in the readout.
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

  const start = useCallback(
    async (m: Mode) => {
      endingRef.current = false
      setError('')
      setMode(m)
      modeRef.current = m
      setPaused(false)
      pausedRef.current = false
      setPhase('connecting')
      linesRef.current = []
      setLines([])
      setResult(null)
      // Guard against a handshake that never completes (onConnect never fires).
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
          // Confirm mic permission, then RELEASE the device immediately: the
          // ElevenLabs SDK opens its OWN capture in startSession, and leaving this
          // probe stream live held the device, which on several platforms gave the
          // SDK a busy/silent input, so the agent greeted then ended hearing
          // nothing (VAD ~0). acquireMic also fails clearly in an in-app browser /
          // insecure context instead of an opaque undefined error.
          const stream = await acquireMic()
          const t = stream.getAudioTracks()[0]
          log(`mic permission granted: tracks=${stream.getAudioTracks().length} state=${t?.readyState} enabled=${t?.enabled} muted=${t?.muted}`)
          reportObs({ subsystem: 'interview', event: 'mic_ok', meta: { mode: m, micState: t?.readyState ?? 'unknown' } })
          // KEEP it alive for the session so the browser-level meter runs alongside
          // the SDK's own capture (Chrome allows concurrent getUserMedia). This is
          // the signal that separates "browser gets NO audio" from "browser gets
          // audio but the ElevenLabs SDK/AudioContext does not". Released in end()/
          // the error catch below / unmount.
          micStreamRef.current = stream
        } catch (e) {
          log(`getUserMedia failed: ${e instanceof Error ? e.message : String(e)}`)
          reportObs({ subsystem: 'interview', event: 'mic_error', level: 'error', errorMessage: e instanceof Error ? e.message : String(e), meta: { mode: m } })
          throw e instanceof Error ? e : new Error(describeMicError(e))
        }
        log('POST /api/interview/start')
        const res = await fetch('/api/interview/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: m,
            timeZone: localTimeZone(),
            target: target ? { kind: target.kind, id: target.id, seed: target.seed } : undefined,
          }),
        })
        const cfg = (await res.json()) as {
          sessionId?: string
          signedUrl?: string
          systemPrompt?: string
          firstMessage?: string
          error?: string
          targetKind?: string | null
          targetId?: string | null
        }
        if (!res.ok || !cfg.signedUrl) throw new Error(cfg.error || 'could not start interview')
        sessionIdRef.current = cfg.sessionId ?? null
        targetKindRef.current = cfg.targetKind ?? null
        targetIdRef.current = cfg.targetId ?? null

        try {
          // overrides require the agent's dashboard override toggles to be ON;
          // otherwise ElevenLabs rejects the session (see README). The conversation
          // id arrives via onConnect.
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
        releaseStream(micStreamRef.current)
        micStreamRef.current = null
        setError(e instanceof Error ? e.message : String(e))
        setPhase('error')
      }
    },
    [conversation, target, log]
  )

  const end = useCallback(async () => {
    endingRef.current = true
    log('end() invoked by user -> endSession()')
    setPhase('saving')
    try {
      await conversation.endSession()
    } catch {
      // ignore; we still try to save
    }
    releaseStream(micStreamRef.current)
    micStreamRef.current = null
    try {
      const res = await fetch('/api/interview/end', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          conversationId: convIdRef.current,
          transcript: linesRef.current.map((l) => `${l.role}: ${l.text}`).join('\n'),
          targetKind: targetKindRef.current,
          targetId: targetIdRef.current,
        }),
      })
      const j = (await res.json()) as { captured?: boolean; transcriptLength?: number; error?: string }
      if (!res.ok) throw new Error(j.error || 'could not save')
      setResult({ captured: Boolean(j.captured), length: j.transcriptLength ?? 0 })
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [conversation, log])

  return (
    <div>
      {phase === 'choose' ? (
        target ? (
          <div style={{ display: 'grid', gap: 12, maxWidth: 420, marginTop: 20 }}>
            <p className="mp-sub" style={{ marginTop: 0 }}>
              {target.kind === 'person'
                ? `An interview to add context about ${target.label ?? 'this person'}.`
                : 'An interview to go deeper on what you were exploring.'}
            </p>
            <button type="button" className="mp-btn mp-btn--primary mp-btn--block" onClick={() => start('daily')}>Start interview</button>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12, maxWidth: 380, marginTop: 20 }}>
            <button type="button" className="mp-btn mp-btn--primary mp-btn--block" onClick={() => start('open')}>Open brain-dump</button>
            <button type="button" className="mp-btn mp-btn--ghost mp-btn--block" onClick={() => start('daily')}>Daily check-in (graph-aware)</button>
          </div>
        )
      ) : null}

      {phase === 'connecting' || phase === 'live' ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, marginTop: 28 }}>
          <BrandSeed size={224} mark={88} />
          <p className="mp-eyebrow mp-eyebrow--accent" style={{ letterSpacing: '0.22em' }}>
            {phase === 'connecting'
              ? mode === 'daily' ? 'Composing your brief...' : 'Connecting...'
              : paused ? 'Paused' : conversation.isSpeaking ? 'Memo is speaking...' : 'Listening...'}
          </p>
          {phase === 'live' ? (
            <>
              {paused ? (
                <p className="mp-meta" style={{ textAlign: 'center', maxWidth: 300 }}>
                  Your mic is muted, so Memo is waiting. Resume when you are ready.
                </p>
              ) : null}
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" className="mp-btn mp-btn--ghost" onClick={togglePause}>
                  {paused ? 'Resume' : 'Pause'}
                </button>
                <button type="button" className="mp-btn mp-btn--ghost" onClick={end}>End and save</button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {phase === 'saving' ? <p className="mp-sub" style={{ marginTop: 20 }}>Saving the transcript...</p> : null}

      {phase === 'done' && result ? (
        <p className="mp-ok mp-rise" style={{ marginTop: 20 }}>
          {result.captured
            ? `Captured (${result.length} chars). Run the miner to fold it into your graph.`
            : 'Ended. The conversation was too short to capture.'}
        </p>
      ) : null}

      {error ? <p className="mp-bad mp-rise" style={{ marginTop: 16 }}>{error}</p> : null}

      {lines.length > 0 ? (
        <div className="mp-card mp-card--recessed" style={{ marginTop: 18, maxHeight: 320, overflowY: 'auto' }}>
          {lines.map((l, i) => (
            <p key={i} style={{ margin: '6px 0', lineHeight: 1.45 }}>
              <strong style={{ color: 'var(--accent)', fontWeight: 500 }}>{l.role}:</strong> {l.text}
            </p>
          ))}
        </div>
      ) : null}


      <DebugReadout title="/capture/interview" status={liveStatus} lines={dbgLines} />
    </div>
  )
}

