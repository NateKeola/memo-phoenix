import { AuthForms } from '@/components/auth/auth-forms'

// The entry screen. Email + password only (no magic link, no email dependency).
// Sign in for returning users, Create account for an invited (allowlisted) person.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; mode?: string }>
}) {
  const { error, mode } = await searchParams
  const initialMode = mode === 'create' ? 'create' : 'signin'

  return (
    <main className="mp-stage">
      <div>
        <div style={{ textAlign: 'center', marginBottom: 26 }}>
          <span className="mp-mark" style={{ display: 'block', width: 64, height: 64, margin: '0 auto 14px' }} aria-hidden />
          <h1 className="mp-h2">Memo</h1>
          <p className="mp-sub" style={{ marginTop: 6 }}>A companion that remembers your life.</p>
        </div>
        <AuthForms error={error} mode={initialMode} />
      </div>
    </main>
  )
}
