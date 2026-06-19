'use client'

import { useRef, useState } from 'react'

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
    <div style={{ display: 'grid', gap: 12 }}>
      <div
        ref={scrollRef}
        style={{
          minHeight: 200,
          maxHeight: 460,
          overflowY: 'auto',
          border: '1px solid #ddd',
          borderRadius: 8,
          padding: 12,
          background: '#fafafa',
        }}
      >
        {messages.length === 0 ? (
          <p style={{ color: '#888', margin: 0 }}>No messages yet. Ask a question below.</p>
        ) : (
          messages.map((m, i) => (
            <div key={i} style={{ margin: '8px 0' }}>
              <strong style={{ color: m.role === 'user' ? '#1a1a1a' : '#0a6' }}>
                {m.role === 'user' ? 'You' : 'Memo'}:
              </strong>{' '}
              <span style={{ whiteSpace: 'pre-wrap' }}>
                {m.content || (busy && i === messages.length - 1 ? 'thinking...' : '')}
              </span>
            </div>
          ))
        )}
      </div>

      {error ? <p style={{ color: 'crimson', margin: 0 }}>{error}</p> : null}

      <div style={{ display: 'flex', gap: 8 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about your corpus..."
          rows={2}
          style={{ flex: 1, padding: 8, fontFamily: 'inherit', fontSize: 14, resize: 'vertical' }}
        />
        <button type="button" onClick={() => void send()} disabled={busy || !input.trim()} style={{ padding: '0 16px' }}>
          {busy ? '...' : 'Send'}
        </button>
      </div>
    </div>
  )
}
