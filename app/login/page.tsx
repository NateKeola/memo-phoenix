import { AuthForms } from '@/components/auth/auth-forms'

// The entry screen. Email + password only (no magic link, no email dependency).
// Sign in for returning users, Create account for an invited (allowlisted) person.
// Visual polish comes in the redesign; this is functional and clear.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; mode?: string }>
}) {
  const { error, mode } = await searchParams
  const initialMode = mode === 'create' ? 'create' : 'signin'

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 420 }}>
      <h1>Memo Phoenix</h1>
      <AuthForms error={error} mode={initialMode} />
    </main>
  )
}
