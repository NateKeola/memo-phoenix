'use client'

import { useActionState } from 'react'
import { inviteAction, type InviteState } from '@/app/admin/actions'

// Operator-only invite form. Inviting just adds the email to the allowlist; there
// is no link to copy and no email sent. The person creates their own account at the
// sign-in page with that email and a password.
export function InviteForm() {
  const [state, action, pending] = useActionState<InviteState, FormData>(inviteAction, {})

  return (
    <div style={{ margin: '16px 0', maxWidth: 460 }}>
      <form action={action} style={{ display: 'grid', gap: 8 }}>
        <input name="email" type="email" placeholder="person@example.com" autoComplete="off" required />
        <input name="note" type="text" placeholder="note (optional)" autoComplete="off" />
        <button type="submit" disabled={pending}>
          {pending ? 'Inviting...' : 'Invite'}
        </button>
      </form>

      {state?.error ? <p style={{ color: 'crimson' }}>{state.error}</p> : null}

      {state?.ok ? (
        <div style={{ marginTop: 12, background: '#f5f5f5', padding: 12, borderRadius: 8 }}>
          <p style={{ margin: 0 }}>
            Invited <strong>{state.email}</strong>. They can now create their account at the sign-in
            page using this email and a password they choose.
          </p>
        </div>
      ) : null}
    </div>
  )
}
