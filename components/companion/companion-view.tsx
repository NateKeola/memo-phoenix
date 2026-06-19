'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { FollowUp, Today, UpcomingEvent } from '@/lib/companion/today'
import {
  createEventAction,
  draftCalendarAction,
  draftEmailAction,
  sendEmailAction,
  setCommitmentState,
} from '@/app/companion/actions'

type Connection = { connected: boolean; email: string | null; configured: boolean }

const NOTICES: Record<string, string> = {
  connected: 'Google connected.',
  disconnected: 'Google disconnected.',
  denied: 'Google connection was cancelled.',
  error: 'Could not complete the Google connection.',
  state_mismatch: 'The connection request expired. Try again.',
  unconfigured: 'Google actions are not configured on this server.',
}

export function CompanionView({
  today,
  connection,
  googleNotice,
}: {
  today: Today
  connection: Connection
  googleNotice: string | null
}) {
  const notice = googleNotice ? NOTICES[googleNotice] ?? null : null
  return (
    <div>
      <ConnectionBanner connection={connection} />
      {notice ? <p style={{ color: '#0a6' }}>{notice}</p> : null}

      <Group title="Overdue" items={today.overdue} connection={connection} />
      <Group title="Soon" items={today.soon} connection={connection} />
      <Group title="Open" items={today.open} connection={connection} />

      {today.snoozed.length > 0 ? (
        <details style={{ marginTop: 16 }}>
          <summary>Snoozed ({today.snoozed.length})</summary>
          <Group title="" items={today.snoozed} connection={connection} />
        </details>
      ) : null}

      {today.counts.active === 0 ? (
        <p style={{ color: '#888' }}>Nothing needs attention right now.</p>
      ) : null}

      {today.upcomingEvents.length > 0 ? <UpcomingEvents events={today.upcomingEvents} /> : null}
    </div>
  )
}

function ConnectionBanner({ connection }: { connection: Connection }) {
  if (!connection.configured) {
    return (
      <p style={{ background: '#fff8e1', padding: 10, borderRadius: 8, fontSize: 13 }}>
        Email and calendar actions are not configured on this server. The rest of the view works; set
        up the Google connection to draft and send.
      </p>
    )
  }
  if (!connection.connected) {
    return (
      <p style={{ background: '#f0f4ff', padding: 10, borderRadius: 8, fontSize: 13 }}>
        Connect Gmail and Calendar to draft and send follow-ups.{' '}
        <a href="/api/google/connect">Connect Google</a>
      </p>
    )
  }
  return (
    <p style={{ background: '#f3fbf3', padding: 10, borderRadius: 8, fontSize: 13 }}>
      Connected as {connection.email ?? 'your Google account'}.{' '}
      <form action="/api/google/disconnect" method="post" style={{ display: 'inline' }}>
        <button type="submit" style={{ border: 'none', background: 'none', color: '#06c', cursor: 'pointer', padding: 0 }}>
          Disconnect
        </button>
      </form>
    </p>
  )
}

function Group({ title, items, connection }: { title: string; items: FollowUp[]; connection: Connection }) {
  if (items.length === 0) return null
  return (
    <section style={{ marginTop: 16 }}>
      {title ? <h2 style={{ fontSize: 16, marginBottom: 8 }}>{title}</h2> : null}
      <div style={{ display: 'grid', gap: 8 }}>
        {items.map((it) => (
          <FollowUpItem key={it.commitmentId} item={it} connection={connection} />
        ))}
      </div>
    </section>
  )
}

type Mode = null | 'email' | 'calendar'

function FollowUpItem({ item, connection }: { item: FollowUp; connection: Connection }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<Mode>(null)
  const [err, setErr] = useState('')

  // email draft fields
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  // calendar draft fields
  const [title, setTitle] = useState('')
  const [startLocal, setStartLocal] = useState('')
  const [duration, setDuration] = useState(30)
  const [attendee, setAttendee] = useState('')
  const [description, setDescription] = useState('')

  const [sentMsg, setSentMsg] = useState('')

  async function changeState(state: 'done' | 'snoozed' | 'dismissed') {
    if (busy) return
    setBusy(true)
    setErr('')
    try {
      const res = await setCommitmentState({ commitmentId: item.commitmentId, state, snoozeDays: 3 })
      if (!res.ok) throw new Error(res.error || 'could not update')
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function openDraft(kind: 'email' | 'calendar') {
    if (busy) return
    setErr('')
    setSentMsg('')
    setBusy(true)
    try {
      const res = kind === 'email' ? await draftEmailAction({ commitmentId: item.commitmentId }) : await draftCalendarAction({ commitmentId: item.commitmentId })
      if (!res.ok) throw new Error(res.error)
      if (res.kind === 'email') {
        setSubject(res.draft.subject)
        setBody(res.draft.body)
        setMode('email')
      } else {
        setTitle(res.draft.title)
        setDuration(res.draft.durationMinutes)
        setDescription(res.draft.description)
        setMode('calendar')
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function sendEmail() {
    if (busy) return
    setErr('')
    setBusy(true)
    try {
      const res = await sendEmailAction({ commitmentId: item.commitmentId, to, subject, body, confirm: true })
      if (!res.ok) {
        if (res.needsConnect) throw new Error('Connect Google first (link at the top).')
        throw new Error(res.error || 'send failed')
      }
      setSentMsg('Email sent.')
      setMode(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function createEvent() {
    if (busy) return
    setErr('')
    if (!startLocal) {
      setErr('pick a start time')
      return
    }
    setBusy(true)
    try {
      const startISO = new Date(startLocal).toISOString()
      const res = await createEventAction({
        commitmentId: item.commitmentId,
        title,
        startISO,
        durationMinutes: duration,
        attendee: attendee || undefined,
        description,
        confirm: true,
      })
      if (!res.ok) {
        if (res.needsConnect) throw new Error('Connect Google first (link at the top).')
        throw new Error(res.error || 'create failed')
      }
      setSentMsg('Event created.')
      setMode(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ border: '1px solid #e5e5e5', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontWeight: 600 }}>{item.label ?? '(untitled)'}</div>
      <div style={{ fontSize: 13, color: '#555' }}>
        {item.person?.label ? `for ${item.person.label}` : 'no person'}
        {item.due ? ` / due ${item.due}` : ''}
        {item.person?.workOrPersonal ? ` / ${item.person.workOrPersonal}` : ''}
      </div>
      {item.provenance ? <div style={{ fontSize: 12, color: '#999' }}>{item.provenance}</div> : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => changeState('done')} disabled={busy}>
          Done
        </button>
        <button type="button" onClick={() => changeState('snoozed')} disabled={busy}>
          Snooze 3d
        </button>
        <button type="button" onClick={() => changeState('dismissed')} disabled={busy}>
          Dismiss
        </button>
        <button type="button" onClick={() => openDraft('email')} disabled={busy}>
          Draft email
        </button>
        <button type="button" onClick={() => openDraft('calendar')} disabled={busy}>
          Draft invite
        </button>
      </div>

      {mode === 'email' ? (
        <div style={{ marginTop: 10, display: 'grid', gap: 6, background: '#fafafa', padding: 10, borderRadius: 8 }}>
          <strong style={{ fontSize: 13 }}>Review and send</strong>
          <input placeholder="recipient@example.com" value={to} onChange={(e) => setTo(e.target.value)} style={{ padding: 6 }} />
          <input placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} style={{ padding: 6 }} />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} style={{ padding: 6 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={sendEmail} disabled={busy || !connection.connected}>
              {connection.connected ? 'Send email' : 'Connect Google to send'}
            </button>
            <button type="button" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {mode === 'calendar' ? (
        <div style={{ marginTop: 10, display: 'grid', gap: 6, background: '#fafafa', padding: 10, borderRadius: 8 }}>
          <strong style={{ fontSize: 13 }}>Review and create</strong>
          <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} style={{ padding: 6 }} />
          <label style={{ fontSize: 13 }}>
            Start{' '}
            <input type="datetime-local" value={startLocal} onChange={(e) => setStartLocal(e.target.value)} />
          </label>
          <label style={{ fontSize: 13 }}>
            Minutes{' '}
            <input type="number" value={duration} min={5} onChange={(e) => setDuration(Number(e.target.value) || 30)} style={{ width: 70 }} />
          </label>
          <input placeholder="attendee@example.com (optional)" value={attendee} onChange={(e) => setAttendee(e.target.value)} style={{ padding: 6 }} />
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} style={{ padding: 6 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={createEvent} disabled={busy || !connection.connected}>
              {connection.connected ? 'Create event' : 'Connect Google to create'}
            </button>
            <button type="button" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {sentMsg ? <p style={{ color: 'green', fontSize: 13, margin: '6px 0 0' }}>{sentMsg}</p> : null}
      {err ? <p style={{ color: 'crimson', fontSize: 13, margin: '6px 0 0' }}>{err}</p> : null}
    </div>
  )
}

function UpcomingEvents({ events }: { events: UpcomingEvent[] }) {
  return (
    <section style={{ marginTop: 20 }}>
      <h2 style={{ fontSize: 16 }}>Coming up</h2>
      <ul style={{ display: 'grid', gap: 4, paddingLeft: 18 }}>
        {events.map((e) => (
          <li key={e.id}>
            {e.label}
            {e.date ? <span style={{ color: '#777' }}> ({String(e.date)})</span> : null}
            {e.location ? <span style={{ color: '#999' }}> at {String(e.location)}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
