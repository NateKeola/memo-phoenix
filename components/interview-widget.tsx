'use client'

import { PageHeader } from '@/components/page-header'
import { BrandSeed } from '@/components/brand-seed'
import { ConversationProvider, useConversation } from '@elevenlabs/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DebugReadout,
  describeDisconnect,
  diagnosticCallbacks,
  newVadState,
  useInterviewDebug,
  useLiveStatus,
} from '@/components/interview-debug'

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
  const [mode, setMode] = useState<Mode | null>(null)
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
  }, [])

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const t = sp.get('target')
    const id = sp.get('id')
    const seed = sp.get('seed')
    if (t === 'person' && id) setTarget({ kind: 'person', id, label: sp.get('label') ?? undefined })
    else if (t === 'topic' && seed) setTarget({ kind: 'topic', seed })
  }, [])

  const conversation = useConversation({
    ...diagnosticCallbacks(log, vadRef),
    onConnect: (props: { conversationId?: string }) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (props?.conversationId) convIdRef.current = props.conversationId
      log(`onConnect conversationId=${props?.conversationId ?? '?'}`)
      setPhase('live')
    },
    onDisconnect: (details: unknown) => {
      // The End button drives the save flow; nothing to do here. We only LOG why the
      // session ended (reason=user is our own teardown; reason=agent/error is a server
      // close) so a live run shows the cause instead of silently dropping it.
      log(`onDisconnect ${describeDisconnect(details)}`)
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
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    },
  })

  const liveStatus = useLiveStatus(conversation, phase === 'connecting' || phase === 'live', log, vadRef)

  const start = useCallback(
    async (m: Mode) => {
      setError('')
      setMode(m)
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
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          const t = stream.getAudioTracks()[0]
          log(`mic permission granted: tracks=${stream.getAudioTracks().length} state=${t?.readyState} enabled=${t?.enabled} muted=${t?.muted}`)
        } catch (e) {
          const name = (e as DOMException)?.name
          log(`getUserMedia failed: ${name ?? (e instanceof Error ? e.message : String(e))}`)
          throw new Error(
            name === 'NotAllowedError'
              ? 'Microphone access denied. Enable the mic in your browser settings and try again.'
              : `Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`
          )
        }
        log('POST /api/interview/start')
        const res = await fetch('/api/interview/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: m,
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
        setError(e instanceof Error ? e.message : String(e))
        setPhase('error')
      }
    },
    [conversation, target, log]
  )

  const end = useCallback(async () => {
    log('end() invoked by user -> endSession()')
    setPhase('saving')
    try {
      await conversation.endSession()
    } catch {
      // ignore; we still try to save
    }
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
              : conversation.isSpeaking ? 'Memo is speaking...' : 'Listening...'}
          </p>
          {phase === 'live' ? (
            <button type="button" className="mp-btn mp-btn--ghost" onClick={end}>End and save</button>
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
