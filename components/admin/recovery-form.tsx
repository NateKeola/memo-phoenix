'use client'

import { useActionState, useState } from 'react'
import { recoveryLinkAction, type RecoveryState } from '@/app/admin/actions'

// Operator-only "recover a password" form. Generating a recovery link does NOT send
// any email: the operator copies the link shown here and sends it to the person
// directly (text, etc.). The person opens it, lands on /reset-password with a
// recovery session, and chooses a new password. Only allowlisted users can be
// recovered (checked server-side).
export function RecoveryForm() {
  const [state, action, pending] = useActionState<RecoveryState, FormData>(recoveryLinkAction, {})
  const [copied, setCopied] = useState(false)

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard may be unavailable; the link is still selectable in the box.
    }
  }

  return (
    <div style={{ margin: '18px 0' }}>
      <form action={action} style={{ display: 'grid', gap: 10 }}>
        <input
          name="email"
          type="email"
          placeholder="allowlisted person's email"
          autoComplete="off"
          required
          className="mp-input"
        />
        <button
          type="submit"
          className="mp-btn mp-btn--primary"
          style={{ justifySelf: 'start' }}
          disabled={pending}
        >
          {pending ? 'Generating...' : 'Generate recovery link'}
        </button>
      </form>

      {state?.error ? <p className="mp-bad" style={{ marginTop: 12 }}>{state.error}</p> : null}

      {state?.ok && state.link ? (
        <div className="mp-card mp-card--recessed mp-rise" style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 8px' }}>
            Recovery link for{' '}
            <strong style={{ color: 'var(--accent)', fontWeight: 500 }}>{state.email}</strong>. Send
            it to them directly (no email is sent). It lets them set a new password.
          </p>
          <textarea
            readOnly
            value={state.link}
            onFocus={(e) => e.currentTarget.select()}
            className="mp-input"
            rows={3}
            style={{ width: '100%', fontSize: 12, fontFamily: 'monospace', resize: 'vertical' }}
          />
          <button
            type="button"
            onClick={() => copy(state.link!)}
            className="mp-btn mp-btn--ghost"
            style={{ marginTop: 8, padding: '7px 13px', fontSize: 13 }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
