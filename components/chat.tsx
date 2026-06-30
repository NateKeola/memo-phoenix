'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import { IconSend } from '@/components/icons'

type Msg = { role: 'user' | 'assistant'; content: string }

// Minimal chat surface. Holds the recent turns in component state (no durable
// storage), POSTs them to /api/chat, and appends the streamed answer as it
// arrives. Light multi-turn: the whole visible thread is sent as context.
export function Chat() {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    setError('')
    setInput('')
    const next: Msg[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setBusy(true)
    // placeholder assistant message that fills in as the stream arrives
    setMessages((m) => [...m, { role: 'assistant', content: '' }])

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      })
      if (!res.ok || !res.body) {
        let detail = `request failed (${res.status})`
        try {
          const j = (await res.json()) as { error?: string }
          if (j.error) detail = j.error
        } catch {
          // non-JSON error body; keep the status message
        }
        throw new Error(detail)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let acc = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        acc += decoder.decode(value, { stream: true })
        setMessages((m) => {
          const copy = m.slice()
          copy[copy.length - 1] = { role: 'assistant', content: acc }
          return copy
        })
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
      }
      if (!acc.trim()) {
        setMessages((m) => {
          const copy = m.slice()
          copy[copy.length - 1] = { role: 'assistant', content: '(no answer)' }
          return copy
        })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // drop the empty assistant placeholder on hard failure
      setMessages((m) => (m.length && m[m.length - 1].role === 'assistant' && !m[m.length - 1].content ? m.slice(0, -1) : m))
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div style={{ display: 'grid', gap: 14, marginTop: 18 }}>
      <div
        ref={scrollRef}
        className="mp-card mp-card--recessed mp-thread"
        style={{ minHeight: 220, maxHeight: 460 }}
      >
        {messages.length === 0 ? (
          <p className="mp-meta" style={{ margin: 0 }}>No messages yet. Ask a question below.</p>
        ) : (
          messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="mp-bubble-me">
                <span style={{ whiteSpace: 'pre-wrap' }}>{m.content}</span>
              </div>
            ) : (
              <div key={i} className="mp-bubble-agent">
                <span className="mp-mark" style={{ width: 28, height: 28, marginTop: 2 }} aria-hidden />
                <p style={{ whiteSpace: 'pre-wrap' }}>
                  {m.content || (busy && i === messages.length - 1 ? 'thinking...' : '')}
                </p>
              </div>
            )
          )
        )}
      </div>

      {error ? <p className="mp-bad" style={{ margin: 0 }}>{error}</p> : null}

      {(() => {
        // After an answer, the user can go deeper in a voice interview seeded with
        // the chat topic (the chat-to-interview spin-up). The seed is the last
        // question; the interview captures itself and deepens the graph.
        const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content
        const hasAnswer = messages.some((m) => m.role === 'assistant' && m.content.trim())
        if (!busy && lastUser && hasAnswer) {
          const href = `/capture/interview?${new URLSearchParams({ target: 'topic', seed: lastUser.slice(0, 400) }).toString()}`
          return (
            <p style={{ margin: 0 }}>
              <Link href={href} className="mp-link" style={{ fontSize: 14 }}>
                Talk more about this in an interview &rarr;
              </Link>
            </p>
          )
        }
        return null
      })()}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about your corpus..."
          rows={2}
          className="mp-textarea"
          style={{ flex: 1, minHeight: 52 }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !input.trim()}
          aria-label="Send"
          className="mp-btn mp-btn--primary"
          style={{ width: 52, height: 52, padding: 0, borderRadius: '50%', flex: 'none' }}
        >
          <IconSend />
        </button>
      </div>
    </div>
  )
}
