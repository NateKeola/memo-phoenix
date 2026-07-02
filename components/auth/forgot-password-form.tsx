'use client'

import { useActionState } from 'react'
import { requestResetEmailAction, type ForgotState } from '@/app/forgot-password/actions'

// The self-service email-recovery form. Submitting emails a reset link via Supabase
// (reliable once custom SMTP is configured; the page copy covers the fallback). It
// returns a neutral message and never reveals whether an account exists.
export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState<ForgotState, FormData>(requestResetEmailAction, {})

  return (
    <div style={{ marginTop: 18 }}>
      <form action={action} style={{ display: 'grid', gap: 10 }}>
        <input
          name="email"
          type="email"
          placeholder="your email"
          autoComplete="email"
          required
          className="mp-input"
        />
        <button type="submit" className="mp-btn mp-btn--primary mp-btn--block" disabled={pending}>
          {pending ? 'Sending...' : 'Email me a reset link'}
        </button>
      </form>
      {state?.error ? <p className="mp-bad" style={{ marginTop: 12 }}>{state.error}</p> : null}
      {state?.ok && state.message ? (
        <p className="mp-ok mp-rise" style={{ marginTop: 12 }}>{state.message}</p>
      ) : null}
    </div>
  )
}
