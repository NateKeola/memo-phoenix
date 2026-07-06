'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { FollowUp, Today, UpcomingEvent } from '@/lib/companion/today'
import type { RelationshipNudge } from '@/lib/companion/nudges'
import { setCommitmentState, setFollowupTracking, setEventTag } from '@/app/companion/actions'
import { ContextAdder } from '@/components/context-adder'

type PersonOpt = { id: string; name: string }

// Warm-notebook tokens (the shared design system). Colours reference the CSS
// custom properties in globals.css so this surface inherits the same world.
const CARD = 'var(--surf)'
const ACCENT = 'var(--accent)'
const ACCENT_SOFT = 'var(--accent-soft)'
const INK = 'var(--txt)'
const MUTED = 'var(--txt-muted)'
const LINE = 'var(--line-strong)'
const FIELD = 'var(--surf-2)'
const FAINT = 'var(--txt-faint)'
const BAD = 'var(--record-soft)'

const btn: React.CSSProperties = {
  border: `1px solid ${LINE}`,
  background: 'rgba(240, 230, 210, 0.04)',
  color: MUTED,
  borderRadius: 999,
  padding: '6px 13px',
  cursor: 'pointer',
  fontSize: 13,
}
const accentBtn: React.CSSProperties = { ...btn, background: ACCENT_SOFT, borderColor: 'rgba(234, 177, 58, 0.4)', color: ACCENT }

export function CompanionView({ today }: { today: Today }) {
  const people = today.people
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | 'open' | 'done'>('all')
  const [ts, setTs] = useState<'all' | 'yes' | 'no'>('all')
  const [personId, setPersonId] = useState('all')

  const queryActive = q.trim() !== '' || status !== 'all' || ts !== 'all' || personId !== 'all'
  // Deterministic, client-side filter over the already RLS-scoped follow-up set.
  const filtered = today.all.filter((it) => {
    if (status === 'open' && it.status === 'done') return false
    if (status === 'done' && it.status !== 'done') return false
    if (ts === 'yes' && !it.timeSensitive) return false
    if (ts === 'no' && it.timeSensitive) return false
    if (personId !== 'all' && it.person?.id !== personId) return false
    if (q.trim()) {
      const hay = `${it.headline} ${it.suggestion} ${it.person?.label ?? ''}`.toLowerCase()
      if (!hay.includes(q.trim().toLowerCase())) return false
    }
    return true
  })

  const empty =
    today.counts.active === 0 &&
    today.counts.snoozed === 0 &&
    today.counts.past === 0 &&
    today.relationshipNudges.length === 0

  const clear = () => {
    setQ('')
    setStatus('all')
    setTs('all')
    setPersonId('all')
  }

  return (
    <div style={{ color: INK }}>
      <QueryBar
        q={q}
        setQ={setQ}
        status={status}
        setStatus={setStatus}
        ts={ts}
        setTs={setTs}
        personId={personId}
        setPersonId={setPersonId}
        people={people}
        active={queryActive}
        onClear={clear}
      />

      {queryActive ? (
        <section style={{ marginTop: 14 }}>
          <h2 style={{ fontSize: 15, color: ACCENT, margin: '0 0 8px' }}>Results ({filtered.length})</h2>
          {filtered.length === 0 ? (
            <p style={{ color: MUTED }}>No follow-ups match.</p>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {filtered.map((it) => (
                <FollowUpCard key={it.commitmentId} item={it} people={people} />
              ))}
            </div>
          )}
        </section>
      ) : (
        <>
          <FollowUpGroup title="Overdue" items={today.overdue} people={people} />
          <FollowUpGroup title="Soon" items={today.soon} people={people} />
          <FollowUpGroup title="Open" items={today.open} people={people} />

          {today.relationshipNudges.length > 0 ? <Nudges nudges={today.relationshipNudges} /> : null}

          {today.snoozed.length > 0 ? (
            <details style={{ marginTop: 18 }}>
              <summary style={{ color: MUTED }}>Snoozed ({today.snoozed.length})</summary>
              <FollowUpGroup title="" items={today.snoozed} people={people} />
            </details>
          ) : null}

          {today.past.length > 0 ? (
            <details style={{ marginTop: 18 }}>
              <summary style={{ color: MUTED }}>
                Past ({today.past.length}) - time-sensitive, deadline passed
              </summary>
              <FollowUpGroup title="" items={today.past} people={people} />
            </details>
          ) : null}

          {empty ? <p style={{ color: MUTED }}>Nothing to follow up on right now.</p> : null}

          {today.upcomingEvents.length > 0 ? <Upcoming events={today.upcomingEvents} /> : null}
        </>
      )}
    </div>
  )
}

function QueryBar({
  q,
  setQ,
  status,
  setStatus,
  ts,
  setTs,
  personId,
  setPersonId,
  people,
  active,
  onClear,
}: {
  q: string
  setQ: (v: string) => void
  status: 'all' | 'open' | 'done'
  setStatus: (v: 'all' | 'open' | 'done') => void
  ts: 'all' | 'yes' | 'no'
  setTs: (v: 'all' | 'yes' | 'no') => void
  personId: string
  setPersonId: (v: string) => void
  people: PersonOpt[]
  active: boolean
  onClear: () => void
}) {
  return (
    <div style={{ display: 'grid', gap: 8, marginBottom: 4 }}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search follow-ups..."
        style={{ padding: 8, border: `1px solid ${LINE}`, borderRadius: 8, background: FIELD }}
      />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip label="Open" on={status === 'open'} onClick={() => setStatus(status === 'open' ? 'all' : 'open')} />
        <Chip label="Done" on={status === 'done'} onClick={() => setStatus(status === 'done' ? 'all' : 'done')} />
        <Chip label="Time-sensitive" on={ts === 'yes'} onClick={() => setTs(ts === 'yes' ? 'all' : 'yes')} />
        <Chip label="Not time-sensitive" on={ts === 'no'} onClick={() => setTs(ts === 'no' ? 'all' : 'no')} />
        <select
          value={personId}
          onChange={(e) => setPersonId(e.target.value)}
          style={{ ...btn, cursor: 'pointer' }}
        >
          <option value="all">Anyone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {active ? (
          <button type="button" style={btn} onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>
    </div>
  )
}

function Chip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={on ? accentBtn : btn}>
      {label}
    </button>
  )
}

function FollowUpGroup({ title, items, people }: { title: string; items: FollowUp[]; people: PersonOpt[] }) {
  if (items.length === 0) return null
  return (
    <section style={{ marginTop: 18 }}>
      {title ? <h2 style={{ fontSize: 15, color: ACCENT, margin: '0 0 8px' }}>{title}</h2> : null}
      <div style={{ display: 'grid', gap: 10 }}>
        {items.map((it) => (
          <FollowUpCard key={it.commitmentId} item={it} people={people} />
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

function FollowUpCard({ item, people }: { item: FollowUp; people: PersonOpt[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [brainstorm, setBrainstorm] = useState(false)
  const [planning, setPlanning] = useState(false)
  const [dueDate, setDueDate] = useState(item.dueDate ? item.dueDate.slice(0, 10) : '')
  const [linkedPersonId, setLinkedPersonId] = useState(item.linkedPerson?.id ?? '')
  const [tsChoice, setTsChoice] = useState<'auto' | 'on' | 'off'>(
    item.timeSensitiveOverride === true ? 'on' : item.timeSensitiveOverride === false ? 'off' : 'auto'
  )

  async function savePlan() {
    if (busy) return
    setBusy(true)
    setErr('')
    try {
      const res = await setFollowupTracking({
        commitmentId: item.commitmentId,
        dueDate: dueDate || null,
        linkedPersonId: linkedPersonId || null,
        timeSensitive: tsChoice === 'on' ? true : tsChoice === 'off' ? false : null,
        matchLabel: item.headline,
        matchPersonId: item.person?.id ?? null,
      })
      if (!res.ok) throw new Error(res.error || 'could not save')
      setPlanning(false)
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

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

  const planLabel = [
    item.dueDate ? `planned ${item.dueDate.slice(0, 10)}` : null,
    item.linkedPerson ? `with ${item.linkedPerson.name}` : null,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{item.headline}</div>
          <div style={{ color: MUTED, fontSize: 14, marginTop: 2 }}>{item.suggestion}</div>
          {planLabel ? <div style={{ color: ACCENT, fontSize: 12, marginTop: 2 }}>{planLabel}</div> : null}
          {item.timeSensitive ? (
            <div style={{ fontSize: 12, marginTop: 2, color: item.passed ? BAD : ACCENT }}>
              {item.passed ? 'deadline passed' : 'time-sensitive'}
              {item.deadline ? ` (${item.deadline.slice(0, 10)})` : ''}
            </div>
          ) : null}
          {item.provenance ? <div style={{ color: FAINT, fontSize: 12, marginTop: 2 }}>{item.provenance}</div> : null}
        </div>
        <ContextAdder targetKind="commitment" targetId={item.commitmentId} label={item.headline} source="follow_up" compact />
      </div>

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
        <button type="button" style={btn} onClick={() => setPlanning((p) => !p)} disabled={busy}>
          {planning ? 'Close' : 'Plan'}
        </button>
        <button type="button" style={accentBtn} onClick={() => setBrainstorm((b) => !b)} disabled={busy}>
          {brainstorm ? 'Close' : 'Think it through'}
        </button>
      </div>

      {planning ? (
        <div style={{ marginTop: 10, display: 'grid', gap: 6, background: FIELD, border: `1px solid ${LINE}`, borderRadius: 8, padding: 10 }}>
          <p style={{ margin: 0, fontSize: 12, color: MUTED }}>
            Your own tracking only. This does not schedule or send anything. A passed deadline moves
            this to Past, never deletes it.
          </p>
          <label style={{ fontSize: 13 }}>
            Time-sensitive{' '}
            <select value={tsChoice} onChange={(e) => setTsChoice(e.target.value as 'auto' | 'on' | 'off')}>
              <option value="auto">auto (inferred)</option>
              <option value="on">yes</option>
              <option value="off">no</option>
            </select>
          </label>
          <label style={{ fontSize: 13 }}>
            Deadline{' '}
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
          <label style={{ fontSize: 13 }}>
            With{' '}
            <select value={linkedPersonId} onChange={(e) => setLinkedPersonId(e.target.value)}>
              <option value="">no one</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" style={accentBtn} onClick={savePlan} disabled={busy}>
            Save
          </button>
        </div>
      ) : null}

      {brainstorm ? <BrainstormPanel seed={seed} /> : null}
      {err ? <p style={{ color: BAD, fontSize: 13, margin: '6px 0 0' }}>{err}</p> : null}
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
      {nudge.provenance ? <div style={{ color: FAINT, fontSize: 12, marginTop: 2 }}>{nudge.provenance}</div> : null}
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
    <div style={{ marginTop: 10, background: FIELD, border: `1px solid ${LINE}`, borderRadius: 10, padding: 10 }}>
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
      {err ? <p style={{ color: BAD, fontSize: 13, margin: '6px 0 0' }}>{err}</p> : null}
    </div>
  )
}

function Upcoming({ events }: { events: UpcomingEvent[] }) {
  return (
    <section style={{ marginTop: 22 }}>
      <h2 style={{ fontSize: 15, color: ACCENT }}>Coming up</h2>
      <ul style={{ display: 'grid', gap: 10, listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
        {events.map((e) => (
          <EventRow key={e.id} event={e} />
        ))}
      </ul>
    </section>
  )
}

// One upcoming event with a user-set work/personal tag. The tag is stored in the
// event_tags OVERLAY (never canonical), mirroring the work/personal tag people have.
// Tapping the active tag clears it. Optimistic + router.refresh, same idiom as the
// commitment state buttons.
function EventRow({ event }: { event: UpcomingEvent }) {
  const router = useRouter()
  const [tag, setTag] = useState<string | null>(event.workOrPersonal)
  const [busy, setBusy] = useState(false)

  async function choose(value: 'work' | 'personal') {
    if (busy) return
    const next = tag === value ? null : value // tapping the active tag clears it
    setBusy(true)
    setTag(next)
    try {
      const res = await setEventTag({ eventId: event.id, workOrPersonal: next })
      if (!res.ok) throw new Error(res.error || 'could not tag')
      router.refresh()
    } catch {
      setTag(event.workOrPersonal) // revert on failure
    } finally {
      setBusy(false)
    }
  }

  const pill = (value: 'work' | 'personal') => ({
    ...(tag === value ? accentBtn : btn),
    padding: '3px 10px',
    fontSize: 12,
    opacity: busy ? 0.6 : 1,
  })

  return (
    <li style={{ color: MUTED }}>
      <span>
        {event.label}
        {event.date ? <span> ({String(event.date)})</span> : null}
        {event.location ? <span> at {String(event.location)}</span> : null}
      </span>
      <span style={{ display: 'inline-flex', gap: 6, marginLeft: 8, verticalAlign: 'middle' }}>
        <button type="button" style={pill('work')} onClick={() => choose('work')} disabled={busy} aria-pressed={tag === 'work'}>
          work
        </button>
        <button type="button" style={pill('personal')} onClick={() => choose('personal')} disabled={busy} aria-pressed={tag === 'personal'}>
          personal
        </button>
      </span>
    </li>
  )
}
