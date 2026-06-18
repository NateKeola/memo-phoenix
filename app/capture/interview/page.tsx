'use client'

import Link from 'next/link'
import { ConversationProvider, useConversation } from '@elevenlabs/react'
import { useCallback, useEffect, useRef, useState } from 'react'

type Mode = 'open' | 'daily'
type Phase = 'choose' | 'connecting' | 'live' | 'saving' | 'done' | 'error'
type Line = { role: string; text: string }

export default function StartInterviewPage() {
  // The ElevenLabs SDK is browser-only; render it only after mount so it never
  // runs during SSR/prerender.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 640 }}>
      <p><Link href="/">&larr; Home</Link></p>
      <h1>Interview</h1>
      <p>A voice conversation with Memo. It captures itself and feeds the graph on the next miner run.</p>
      {mounted ? (
        <ConversationProvider>
          <Interview />
        </ConversationProvider>
      ) : (
        <p>Loading...</p>
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

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
  }, [])

  const conversation = useConversation({
    onConnect: (props: { conversationId?: string }) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (props?.conversationId) convIdRef.current = props.conversationId
      setPhase('live')
    },
    onDisconnect: () => {
      // The End button drives the save flow; nothing to do here.
    },
    // Best-effort live captions; the authoritative transcript is fetched server-side at end.
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
          body: JSON.stringify({ mode: m }),
        })
        const cfg = (await res.json()) as {
          sessionId?: string
          signedUrl?: string
          systemPrompt?: string
          firstMessage?: string
          error?: string
        }
        if (!res.ok || !cfg.signedUrl) throw new Error(cfg.error || 'could not start interview')
        sessionIdRef.current = cfg.sessionId ?? null

        try {
          // overrides require the agent's dashboard override toggles to be ON;
          // otherwise ElevenLabs rejects the session (see README). The conversation
          // id arrives via onConnect.
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
    },
    [conversation]
  )

  const end = useCallback(async () => {
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
  }, [conversation])

  return (
    <div>
      {phase === 'choose' ? (
        <div style={{ display: 'grid', gap: 12, maxWidth: 360 }}>
          <button type="button" onClick={() => start('open')}>Open brain-dump</button>
          <button type="button" onClick={() => start('daily')}>Daily check-in (graph-aware)</button>
        </div>
      ) : null}

      {phase === 'connecting' ? <p>Connecting{mode === 'daily' ? ' (composing your brief)' : ''}...</p> : null}

      {phase === 'live' ? (
        <div>
          <p>Live ({mode}). {conversation.isSpeaking ? 'Memo is speaking...' : 'Listening...'}</p>
          <button type="button" onClick={end}>End and save</button>
        </div>
      ) : null}

      {phase === 'saving' ? <p>Saving the transcript...</p> : null}

      {phase === 'done' && result ? (
        <p style={{ color: 'green' }}>
          {result.captured
            ? `Captured (${result.length} chars). Run the miner to fold it into your graph.`
            : 'Ended. The conversation was too short to capture.'}
        </p>
      ) : null}

      {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}

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
