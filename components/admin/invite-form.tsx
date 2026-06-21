'use client'

import { useActionState } from 'react'
import { inviteAction, type InviteState } from '@/app/admin/actions'

// Operator-only invite form. On success it shows the generated invite link inline
// (no SMTP required: the operator copies it and shares it however). If SMTP is
// configured in Supabase, the invitee is also emailed the same link.
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
      {state?.warning ? <p style={{ color: '#b8860b' }}>{state.warning}</p> : null}

      {state?.ok && state.actionLink ? (
        <div style={{ marginTop: 12, background: '#f5f5f5', padding: 12, borderRadius: 8 }}>
          <p style={{ margin: '0 0 6px' }}>
            Invited <strong>{state.email}</strong>. Send them this link to set up their account:
          </p>
          <textarea
            readOnly
            value={state.actionLink}
            onFocus={(e) => e.currentTarget.select()}
            rows={3}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
          />
          <p style={{ margin: '6px 0 0', fontSize: 12, color: '#666' }}>
            The link logs them in and starts their onboarding interview. It also goes
            out by email if Supabase SMTP is configured.
          </p>
        </div>
      ) : null}
    </div>
  )
}
