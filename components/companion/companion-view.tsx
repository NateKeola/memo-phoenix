'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { FollowUp, Today, UpcomingEvent } from '@/lib/companion/today'
import type { RelationshipNudge } from '@/lib/companion/nudges'
import { setCommitmentState } from '@/app/companion/actions'

// Warm, neutral placeholder palette (no purple). Temporary direction only; the
// real styling is a V1 pass, so this is plain inline styling, not a theme layer.
const CARD = '#fffdf7'
const ACCENT = '#b07a14'
const ACCENT_SOFT = '#f4ead0'
const INK = '#2c2a25'
const MUTED = '#6f6a5f'
const LINE = '#e7ddc7'

const btn: React.CSSProperties = {
  border: `1px solid ${LINE}`,
  background: '#fffefb',
  color: INK,
  borderRadius: 999,
  padding: '4px 12px',
  cursor: 'pointer',
  fontSize: 13,
}
const accentBtn: React.CSSProperties = { ...btn, background: ACCENT_SOFT, borderColor: ACCENT, color: ACCENT }

export function CompanionView({ today }: { today: Today }) {
  const empty =
    today.counts.active === 0 && today.counts.snoozed === 0 && today.relationshipNudges.length === 0

  return (
    <div style={{ color: INK }}>
      <FollowUpGroup title="Overdue" items={today.overdue} />
      <FollowUpGroup title="Soon" items={today.soon} />
      <FollowUpGroup title="Open" items={today.open} />

      {today.relationshipNudges.length > 0 ? <Nudges nudges={today.relationshipNudges} /> : null}

      {today.snoozed.length > 0 ? (
        <details style={{ marginTop: 18 }}>
          <summary style={{ color: MUTED }}>Snoozed ({today.snoozed.length})</summary>
          <FollowUpGroup title="" items={today.snoozed} />
        </details>
      ) : null}

      {empty ? <p style={{ color: MUTED }}>Nothing to follow up on right now.</p> : null}

      {today.upcomingEvents.length > 0 ? <Upcoming events={today.upcomingEvents} /> : null}
    </div>
  )
}

function FollowUpGroup({ title, items }: { title: string; items: FollowUp[] }) {
  if (items.length === 0) return null
  return (
    <section style={{ marginTop: 18 }}>
      {title ? <h2 style={{ fontSize: 15, color: ACCENT, margin: '0 0 8px' }}>{title}</h2> : null}
      <div style={{ display: 'grid', gap: 10 }}>
        {items.map((it) => (
          <FollowUpCard key={it.commitmentId} item={it} />
        ))}
      </div>
    </section>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, padding: '12px 14px' }}>{children}</div>
  )
}

function FollowUpCard({ item }: { item: FollowUp }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [brainstorm, setBrainstorm] = useState(false)

  async function changeState(state: 'done' | 'snoozed' | 'dismissed') {
    if (busy) return
    setBusy(true)
    setErr('')
    try {
      const res = await setCommitmentState({
        commitmentId: item.commitmentId,
        state,
        snoozeDays: 3,
        matchLabel: item.headline,
        matchPersonId: item.person?.id ?? null,
      })
      if (!res.ok) throw new Error(res.error || 'could not update')
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const seed = `${item.headline}. ${item.suggestion}`

  return (
    <Card>
      <div style={{ fontWeight: 600 }}>{item.headline}</div>
      <div style={{ color: MUTED, fontSize: 14, marginTop: 2 }}>{item.suggestion}</div>
      {item.provenance ? <div style={{ color: '#a59c86', fontSize: 12, marginTop: 2 }}>{item.provenance}</div> : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" style={btn} onClick={() => changeState('done')} disabled={busy}>
          Done
        </button>
        <button type="button" style={btn} onClick={() => changeState('snoozed')} disabled={busy}>
          Snooze 3d
        </button>
        <button type="button" style={btn} onClick={() => changeState('dismissed')} disabled={busy}>
          Dismiss
        </button>
        <button type="button" style={accentBtn} onClick={() => setBrainstorm((b) => !b)} disabled={busy}>
          {brainstorm ? 'Close' : 'Think it through'}
        </button>
      </div>

      {brainstorm ? <BrainstormPanel seed={seed} /> : null}
      {err ? <p style={{ color: 'crimson', fontSize: 13, margin: '6px 0 0' }}>{err}</p> : null}
    </Card>
  )
}

function Nudges({ nudges }: { nudges: RelationshipNudge[] }) {
  return (
    <section style={{ marginTop: 22 }}>
      <h2 style={{ fontSize: 15, color: ACCENT, margin: '0 0 8px' }}>People worth a nudge</h2>
      <div style={{ display: 'grid', gap: 10 }}>
        {nudges.map((n) => (
          <NudgeCard key={n.personId} nudge={n} />
        ))}
      </div>
    </section>
  )
}

function NudgeCard({ nudge }: { nudge: RelationshipNudge }) {
  const [brainstorm, setBrainstorm] = useState(false)
  const seed = `Reconnecting with ${nudge.name ?? 'someone close'} (${nudge.descriptor}). ${nudge.suggestion}`
  return (
    <Card>
      <div style={{ fontWeight: 600 }}>{nudge.name ?? 'Someone close'}</div>
      <div style={{ color: MUTED, fontSize: 14, marginTop: 2 }}>{nudge.suggestion}</div>
      {nudge.provenance ? <div style={{ color: '#a59c86', fontSize: 12, marginTop: 2 }}>{nudge.provenance}</div> : null}
      <div style={{ marginTop: 10 }}>
        <button type="button" style={accentBtn} onClick={() => setBrainstorm((b) => !b)}>
          {brainstorm ? 'Close' : 'Think it through'}
        </button>
      </div>
      {brainstorm ? <BrainstormPanel seed={seed} /> : null}
    </Card>
  )
}

type Msg = { role: 'user' | 'assistant'; content: string }

// A short brainstorm conversation about one follow-up. Auto-opens with one message
// so the companion starts, then the user can continue. It only suggests; the
// /api/companion/brainstorm route never sends anything.
function BrainstormPanel({ seed }: { seed: string }) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const started = useRef(false)

  async function send(history: Msg[]) {
    setBusy(true)
    setErr('')
    setMessages((m) => [...m, { role: 'assistant', content: '' }])
    try {
      const res = await fetch('/api/companion/brainstorm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seed, messages: history }),
      })
      if (!res.ok || !res.body) {
        let detail = `request failed (${res.status})`
        try {
          const j = (await res.json()) as { error?: string }
          if (j.error) detail = j.error
        } catch {
          // keep status
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
      }
      if (!acc.trim()) {
        setMessages((m) => {
          const copy = m.slice()
          copy[copy.length - 1] = { role: 'assistant', content: '(no response)' }
          return copy
        })
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setMessages((m) => (m.length && m[m.length - 1].role === 'assistant' && !m[m.length - 1].content ? m.slice(0, -1) : m))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    const first: Msg[] = [{ role: 'user', content: 'Help me think through what to do here.' }]
    setMessages(first)
    void send(first)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onSubmit() {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    const next: Msg[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    void send(next)
  }

  return (
    <div style={{ marginTop: 10, background: '#fffefb', border: `1px solid ${LINE}`, borderRadius: 10, padding: 10 }}>
      <div style={{ maxHeight: 280, overflowY: 'auto', display: 'grid', gap: 6 }}>
        {messages.map((m, i) => (
          <div key={i}>
            <strong style={{ color: m.role === 'user' ? INK : ACCENT, fontSize: 13 }}>
              {m.role === 'user' ? 'You' : 'Memo'}:
            </strong>{' '}
            <span style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>
              {m.content || (busy && i === messages.length - 1 ? 'thinking...' : '')}
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onSubmit()
            }
          }}
          placeholder="Ask Memo..."
          style={{ flex: 1, padding: 6, border: `1px solid ${LINE}`, borderRadius: 8 }}
        />
        <button type="button" style={accentBtn} onClick={onSubmit} disabled={busy || !input.trim()}>
          Send
        </button>
      </div>
      {err ? <p style={{ color: 'crimson', fontSize: 13, margin: '6px 0 0' }}>{err}</p> : null}
    </div>
  )
}

function Upcoming({ events }: { events: UpcomingEvent[] }) {
  return (
    <section style={{ marginTop: 22 }}>
      <h2 style={{ fontSize: 15, color: ACCENT }}>Coming up</h2>
      <ul style={{ display: 'grid', gap: 4, paddingLeft: 18, color: MUTED }}>
        {events.map((e) => (
          <li key={e.id}>
            {e.label}
            {e.date ? <span> ({String(e.date)})</span> : null}
            {e.location ? <span> at {String(e.location)}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
