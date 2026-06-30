'use client'

import Link from 'next/link'
import { useState } from 'react'
import { addContextNote } from '@/app/context-actions'

// One reusable "add context" control (the capture-with-target mechanism on the
// surface side): add a text note inline, or jump to a memo / interview already
// aimed at this target. Used from a person and from a follow-up.
export function ContextAdder({
  targetKind,
  targetId,
  label,
  source,
  showInterview = false,
  compact = false,
}: {
  targetKind: 'person' | 'commitment'
  targetId: string
  label: string
  source: string
  showInterview?: boolean
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  async function saveNote() {
    if (busy || !note.trim()) return
    setBusy(true)
    setErr('')
    setMsg('')
    try {
      const res = await addContextNote({ body: note, targetKind, targetId, source })
      if (!res.ok) throw new Error(res.error || 'could not save')
      setMsg('Note added. It folds into the graph on the next miner run.')
      setNote('')
      setNoteOpen(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const q = new URLSearchParams({ target_kind: targetKind, target_id: targetId, source, label })
  const memoHref = `/capture/memo?${q.toString()}`
  const interviewHref = `/capture/interview?${new URLSearchParams({ target: 'person', id: targetId, label }).toString()}`

  const link: React.CSSProperties = { fontSize: 13, color: 'var(--accent)' }

  return (
    <span style={{ display: 'inline-block', position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Add context about ${label}`}
        title={`Add context about ${label}`}
        style={{
          fontSize: compact ? 16 : 18,
          width: compact ? 26 : 30,
          height: compact ? 26 : 30,
          lineHeight: 1,
          borderRadius: 999,
          border: '1px solid var(--line-strong)',
          background: 'var(--surf)',
          color: 'var(--accent)',
          cursor: 'pointer',
        }}
      >
        +
      </button>
      {open ? (
        <div
          role="menu"
          style={{ display: 'grid', gap: 8, marginTop: 6, padding: 12, border: '1px solid var(--line-strong)', borderRadius: 14, background: 'var(--surf)', maxWidth: 320, boxShadow: 'var(--shadow-card)', position: 'relative', zIndex: 5 }}
        >
          <button type="button" style={{ ...link, textAlign: 'left', border: 'none', background: 'none', cursor: 'pointer', padding: 0 }} onClick={() => setNoteOpen((n) => !n)}>
            Add note
          </button>
          <Link role="menuitem" style={link} href={memoHref}>
            Add voice memo
          </Link>
          {showInterview && targetKind === 'person' ? (
            <Link role="menuitem" style={link} href={interviewHref}>
              Start interview about {label}
            </Link>
          ) : null}

          {noteOpen ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={`A note about ${label}...`}
                rows={3}
                className="mp-textarea"
                style={{ minHeight: 72 }}
              />
              <button type="button" className="mp-btn mp-btn--ghost" onClick={saveNote} disabled={busy || !note.trim()} style={{ justifySelf: 'start', padding: '8px 14px', fontSize: 14 }}>
                Save note
              </button>
            </div>
          ) : null}

          {msg ? <p className="mp-ok" style={{ fontSize: 12, margin: 0 }}>{msg}</p> : null}
          {err ? <p className="mp-bad" style={{ fontSize: 12, margin: 0 }}>{err}</p> : null}
        </div>
      ) : null}
    </span>
  )
}
