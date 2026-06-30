'use client'

import { useActionState } from 'react'
import { inviteAction, type InviteState } from '@/app/admin/actions'

// Operator-only invite form. Inviting just adds the email to the allowlist; there
// is no link to copy and no email sent. The person creates their own account at the
// sign-in page with that email and a password.
export function InviteForm() {
  const [state, action, pending] = useActionState<InviteState, FormData>(inviteAction, {})

  return (
    <div style={{ margin: '18px 0' }}>
      <form action={action} style={{ display: 'grid', gap: 10 }}>
        <input name="email" type="email" placeholder="person@example.com" autoComplete="off" required className="mp-input" />
        <input name="note" type="text" placeholder="note (optional)" autoComplete="off" className="mp-input" />
        <button type="submit" className="mp-btn mp-btn--primary" style={{ justifySelf: 'start' }} disabled={pending}>
          {pending ? 'Inviting...' : 'Invite'}
        </button>
      </form>

      {state?.error ? <p className="mp-bad" style={{ marginTop: 12 }}>{state.error}</p> : null}

      {state?.ok ? (
        <div className="mp-card mp-card--recessed mp-rise" style={{ marginTop: 12 }}>
          <p style={{ margin: 0 }}>
            Invited <strong style={{ color: 'var(--accent)', fontWeight: 500 }}>{state.email}</strong>. They can now create their
            account at the sign-in page using this email and a password they choose.
          </p>
        </div>
      ) : null}
    </div>
  )
}
