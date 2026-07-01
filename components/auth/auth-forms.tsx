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
        padding: '8px 4px',
        border: 'none',
        borderBottom: mode === m ? '2px solid var(--accent)' : '2px solid transparent',
        background: 'none',
        color: mode === m ? 'var(--txt)' : 'var(--txt-faint)',
        fontFamily: 'inherit',
        fontSize: 15,
        fontWeight: mode === m ? 500 : 400,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 18, borderBottom: '1px solid var(--line)' }}>
        {tab('signin', 'Sign in')}
        {tab('create', 'Create account')}
      </div>

      {error ? <p className="mp-bad mp-rise" style={{ marginTop: 0 }}>{error}</p> : null}

      {mode === 'signin' ? (
        <section>
          <p className="mp-meta" style={{ margin: '0 0 12px' }}>Sign in with your email and password.</p>
          <form action={login} style={{ display: 'grid', gap: 10 }}>
            <input name="email" type="email" placeholder="email" autoComplete="email" required className="mp-input" />
            <input
              name="password"
              type="password"
              placeholder="password"
              autoComplete="current-password"
              required
              className="mp-input"
            />
            <button type="submit" className="mp-btn mp-btn--primary mp-btn--block">Sign in</button>
          </form>
        </section>
      ) : (
        <section>
          <p className="mp-meta" style={{ margin: '0 0 12px' }}>
            Invited? Enter your invited email and choose a password. Access is invite-only.
          </p>
          <form action={createAccount} style={{ display: 'grid', gap: 10 }}>
            <input name="email" type="email" placeholder="your invited email" autoComplete="email" required className="mp-input" />
            <input
              name="password"
              type="password"
              placeholder="choose a password"
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
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
            <button type="submit" className="mp-btn mp-btn--primary mp-btn--block">Create account</button>
          </form>
        </section>
      )}

      <p className="mp-meta" style={{ marginTop: 24 }}>
        <a href="/forgot-password" className="mp-link">Forgot your password?</a>
      </p>
      <p className="mp-meta" style={{ marginTop: 8 }}>
        Apple and Google sign-in are coming later.
      </p>
    </div>
  )
}
