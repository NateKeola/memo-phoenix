import { login } from './actions'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 360 }}>
      <h1>Memo Phoenix</h1>
      <p>Sign in</p>
      {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}
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
      {/* No sign-up UI: this is a single-user app. */}
    </main>
  )
}
