'use client'

import { useRouter } from 'next/navigation'
import { ConversationProvider, useConversation } from '@elevenlabs/react'
import { useCallback, useEffect, useRef, useState } from 'react'

type Phase = 'intro' | 'connecting' | 'live' | 'saving' | 'error'
type Line = { role: string; text: string }

// The first-run onboarding interview. Reuses the existing interview agent and the
// open-mode mechanism (signed URL + conversation_config_override) via the same
// /api/interview/start and /api/interview/end routes, but in mode='onboarding'
// (the intro bible). On completion it marks the user onboarded and sends them to
// the "building your memory" page, which kicks off the miner off the local machine.
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

function Inner() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('intro')
  const [error, setError] = useState('')
  const [lines, setLines] = useState<Line[]>([])

  const sessionIdRef = useRef<string | null>(null)
  const convIdRef = useRef<string | null>(null)
  const linesRef = useRef<Line[]>([])
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
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
      // The Finish button drives the save flow.
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

  const finish = useCallback(async () => {
    setPhase('saving')
    try {
      await conversation.endSession()
    } catch {
      // ignore; we still try to save
    }
    try {
      // 1) write the interview capture (the seed for this user's graph)
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
      // 2) mark onboarding complete (releases the app gate + accepts the invite)
      const compRes = await fetch('/api/onboarding/complete', { method: 'POST' })
      if (!compRes.ok) {
        const j = (await compRes.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error || 'could not complete onboarding')
      }
      // 3) hand off to the build page, which kicks off the miner off-machine
      router.push('/building')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [conversation, router])

  return (
    <div>
      {phase === 'intro' ? (
        <div style={{ display: 'grid', gap: 12, maxWidth: 440 }}>
          <p>
            When you are ready, start the conversation. Talk as long as feels natural. When you are
            done, press Finish and Memo will start building your memory.
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
          <button type="button" onClick={finish}>
            Finish and build my memory
          </button>
        </div>
      ) : null}

      {phase === 'saving' ? <p>Saving your conversation...</p> : null}

      {phase === 'error' ? (
        <div style={{ display: 'grid', gap: 8, maxWidth: 440 }}>
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
