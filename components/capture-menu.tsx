'use client'

import Link from 'next/link'
import { useState } from 'react'

// The always-reachable capture entry point: a prominent + that opens the three
// distinct paths. Separate flows, not one merged input.
export function CaptureMenu() {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ margin: '16px 0' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Add a capture"
        style={{ fontSize: 28, width: 48, height: 48, lineHeight: '44px', borderRadius: 24, cursor: 'pointer' }}
      >
        +
      </button>
      {open ? (
        <div role="menu" style={{ display: 'grid', gap: 8, marginTop: 8, maxWidth: 240 }}>
          <Link role="menuitem" href="/capture/text">Add text</Link>
          <Link role="menuitem" href="/capture/memo">Add memo</Link>
          <Link role="menuitem" href="/capture/interview">Start interview</Link>
        </div>
      ) : null}
    </div>
  )
}
