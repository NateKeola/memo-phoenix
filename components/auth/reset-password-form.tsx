'use client'

import { useState } from 'react'
import { updatePasswordAction } from '@/app/reset-password/actions'
import { PASSWORD_CHECKS } from '@/lib/auth/password'

// The new-password form on the recovery page. Shows the SAME live password checklist
// as signup (one source of truth: lib/auth/password), and a confirm field to catch
// typos. The server action re-enforces the policy and the match, then updates the
// password on the recovery session.
export function ResetPasswordForm({ error }: { error?: string }) {
  const [pw, setPw] = useState('')

  return (
    <section>
      <p className="mp-meta" style={{ margin: '0 0 12px' }}>
        Choose a new password for your account.
      </p>

      {error ? <p className="mp-bad mp-rise" style={{ marginTop: 0 }}>{error}</p> : null}

      <form action={updatePasswordAction} style={{ display: 'grid', gap: 10 }}>
        <input
          name="password"
          type="password"
          placeholder="new password"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          required
          className="mp-input"
        />
        <input
          name="confirm"
          type="password"
          placeholder="confirm new password"
          autoComplete="new-password"
          required
          className="mp-input"
        />
        <ul style={{ listStyle: 'none', padding: 0, margin: '2px 0', fontSize: 13, display: 'grid', gap: 4 }}>
          {PASSWORD_CHECKS.map((c) => {
            const ok = c.test(pw)
            return (
              <li key={c.id} style={{ color: ok ? 'var(--ok)' : 'var(--txt-faint)' }}>
                {ok ? '✓' : '○'} {c.label}
              </li>
            )
          })}
        </ul>
        <button type="submit" className="mp-btn mp-btn--primary mp-btn--block">
          Set new password
        </button>
      </form>
    </section>
  )
}
