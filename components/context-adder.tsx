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

  const link: React.CSSProperties = { fontSize: 13, color: '#b07a14' }

  return (
    <span style={{ display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Add context about ${label}`}
        title={`Add context about ${label}`}
        style={{
          fontSize: compact ? 14 : 16,
          width: compact ? 24 : 28,
          height: compact ? 24 : 28,
          lineHeight: 1,
          borderRadius: 999,
          border: '1px solid #e7ddc7',
          background: '#fffefb',
          cursor: 'pointer',
        }}
      >
        +
      </button>
      {open ? (
        <div
          role="menu"
          style={{ display: 'grid', gap: 6, marginTop: 6, padding: 8, border: '1px solid #e7ddc7', borderRadius: 8, background: '#fffdf7', maxWidth: 320 }}
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
            <div style={{ display: 'grid', gap: 6 }}>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={`A note about ${label}...`}
                rows={3}
                style={{ padding: 6, border: '1px solid #e7ddc7', borderRadius: 6 }}
              />
              <button type="button" onClick={saveNote} disabled={busy || !note.trim()} style={{ justifySelf: 'start' }}>
                Save note
              </button>
            </div>
          ) : null}

          {msg ? <p style={{ color: 'green', fontSize: 12, margin: 0 }}>{msg}</p> : null}
          {err ? <p style={{ color: 'crimson', fontSize: 12, margin: 0 }}>{err}</p> : null}
        </div>
      ) : null}
    </span>
  )
}
