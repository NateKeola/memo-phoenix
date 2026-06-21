import { login, requestAccess } from './actions'

// The entry screen. Two clear paths: Sign in (a returning user, email + password)
// and Create account (an invited person setting up, email -> magic sign-in link).
// Access stays invite-only: Create account only works for an invited email, and the
// link only signs in an existing invited account (public signups stay disabled).
// Visual polish comes in the redesign; this is functional and clear.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>
}) {
  const { error, notice } = await searchParams

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 420 }}>
      <h1>Memo Phoenix</h1>
      {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}
      {notice ? <p style={{ color: 'green' }}>{notice}</p> : null}

      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 18, margin: '0 0 4px' }}>Sign in</h2>
        <p style={{ color: '#666', fontSize: 14, margin: '0 0 8px' }}>
          Returning? Sign in with your email and password.
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

      <hr style={{ margin: '24px 0', border: 0, borderTop: '1px solid #e5e5e5' }} />

      <section>
        <h2 style={{ fontSize: 18, margin: '0 0 4px' }}>Create account</h2>
        <p style={{ color: '#666', fontSize: 14, margin: '0 0 8px' }}>
          Invited? Enter your invited email and we will send you a sign-in link to set up your
          account. Access is invite-only.
        </p>
        <form action={requestAccess} style={{ display: 'grid', gap: 8 }}>
          <input name="email" type="email" placeholder="your invited email" autoComplete="email" required />
          <button type="submit">Send my sign-in link</button>
        </form>
      </section>

      <p style={{ color: '#999', fontSize: 12, marginTop: 24 }}>Apple and Google sign-in are coming later.</p>
    </main>
  )
}
