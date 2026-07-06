'use client'

import Link from 'next/link'
import { useState } from 'react'
import { IconPlus, IconInterview, IconMic, IconText } from '@/components/icons'

// The always-reachable capture entry: a gold + (the FAB) that opens the three
// distinct paths. Separate flows, not one merged input.
//
// personId (set by AppChrome only on a person's profile) makes the FAB
// context-aware: the capture is tagged with that person as a hint the miner consumes
// at extraction (target metadata on the capture, never a graph edit). Memo + Text
// take target_kind/target_id; interview takes target/id (the conventions the existing
// capture routes + ContextAdder already parse). Absent personId = context-free.
export function CaptureMenu({ personId }: { personId?: string }) {
  const [open, setOpen] = useState(false)
  const tq = personId ? `?target_kind=person&target_id=${personId}&source=fab_person` : ''
  const iq = personId ? `?target=person&id=${personId}&source=fab_person` : ''
  const PATHS = [
    { href: `/capture/interview${iq}`, label: 'Interview', Icon: IconInterview },
    { href: `/capture/memo${tq}`, label: 'Memo', Icon: IconMic },
    { href: `/capture/text${tq}`, label: 'Text', Icon: IconText },
  ]
  return (
    <>
      {open ? <div className="mp-scrim" onClick={() => setOpen(false)} aria-hidden /> : null}

      {open ? (
        <div
          role="menu"
          className="mp-pop"
          style={{
            position: 'fixed',
            zIndex: 32,
            right: 'max(16px, calc(50% - var(--col) / 2 + 16px))',
            bottom: 178,
            width: 196,
            background: 'var(--surf)',
            border: '1px solid var(--line-strong)',
            borderRadius: 18,
            padding: 5,
            boxShadow: '0 22px 56px rgba(20,14,7,0.62)',
          }}
        >
          {PATHS.map(({ href, label, Icon }) => (
            <Link
              key={href}
              role="menuitem"
              href={href}
              onClick={() => setOpen(false)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 9px',
                borderRadius: 12,
                color: 'var(--txt)',
              }}
            >
              <span
                style={{
                  flex: 'none',
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: 'var(--accent-soft)',
                  color: 'var(--accent)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon />
              </span>
              <span style={{ fontSize: 16 }}>{label}</span>
            </Link>
          ))}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? 'Close capture menu' : 'Add a capture'}
        className={`mp-fab${open ? ' mp-fab--open' : ''}`}
      >
        <IconPlus />
      </button>
    </>
  )
}
