'use client'

import { useState } from 'react'
import { login, createAccount } from '@/app/login/actions'
import { PASSWORD_CHECKS } from '@/lib/auth/password'

// The entry screen. Two clear paths, toggled by a tab: Sign in (returning user,
// email + password) and Create account (an invited person, email + password). No
// magic link, no email: both complete in-band. The create form shows a live
// password checklist (the SAME checks the server enforces). Access stays invite-
// only: Create account only succeeds for an allowlisted email (checked server-side).
export function AuthForms({ error, mode: initialMode }: { error?: string; mode?: 'signin' | 'create' }) {
  const [mode, setMode] = useState<'signin' | 'create'>(initialMode ?? 'signin')
  const [pw, setPw] = useState('')

  const tab = (m: 'signin' | 'create', label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      style={{
        padding: '6px 12px',
        border: 'none',
        borderBottom: mode === m ? '2px solid #b8860b' : '2px solid transparent',
        background: 'none',
        fontWeight: mode === m ? 600 : 400,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )

  return (
    <div style={{ maxWidth: 420 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid #e5e5e5' }}>
        {tab('signin', 'Sign in')}
        {tab('create', 'Create account')}
      </div>

      {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}

      {mode === 'signin' ? (
        <section>
          <p style={{ color: '#666', fontSize: 14, margin: '0 0 8px' }}>
            Sign in with your email and password.
          </p>
          <form action={login} style={{ display: 'grid', gap: 8 }}>
            <input name="email" type="email" placeholder="email" autoComplete="email" required />
            <input
              name="password"
              type="password"
              placeholder="password"
              autoComplete="current-password"
              required
            />
            <button type="submit">Sign in</button>
          </form>
        </section>
      ) : (
        <section>
          <p style={{ color: '#666', fontSize: 14, margin: '0 0 8px' }}>
            Invited? Enter your invited email and choose a password. Access is invite-only.
          </p>
          <form action={createAccount} style={{ display: 'grid', gap: 8 }}>
            <input name="email" type="email" placeholder="your invited email" autoComplete="email" required />
            <input
              name="password"
              type="password"
              placeholder="choose a password"
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              required
            />
            <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0', fontSize: 13 }}>
              {PASSWORD_CHECKS.map((c) => {
                const ok = c.test(pw)
                return (
                  <li key={c.id} style={{ color: ok ? 'green' : '#999' }}>
                    {ok ? '✓' : '○'} {c.label}
                  </li>
                )
              })}
            </ul>
            <button type="submit">Create account</button>
          </form>
        </section>
      )}

      <p style={{ color: '#999', fontSize: 12, marginTop: 24 }}>
        Apple and Google sign-in are coming later. Forgot your password? Contact your admin.
      </p>
    </div>
  )
}
