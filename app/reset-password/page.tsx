import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { ResetPasswordForm } from '@/components/auth/reset-password-form'

export const dynamic = 'force-dynamic'

// Where a recovery link lands (via /auth/callback, which verifies the token and
// establishes the recovery session). If that session is present, the user sets a new
// password here. If it is absent (expired or invalid link, or a direct visit), we
// show a plain "this link has expired" state, never a crash or a silent bounce.
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const expired = !user || error === 'expired'
  // A non-"expired" error is a validation failure on a live session; keep the form.
  const formError = error && error !== 'expired' ? error : undefined

  return (
    <main className="mp-stage">
      <div>
        <div style={{ textAlign: 'center', marginBottom: 26 }}>
          <span
            className="mp-mark"
            style={{ display: 'block', width: 64, height: 64, margin: '0 auto 14px' }}
            aria-hidden
          />
          <h1 className="mp-h2">Set a new password</h1>
        </div>

        {expired ? (
          <div style={{ textAlign: 'center' }}>
            <p className="mp-sub">
              This recovery link has expired or is no longer valid.
            </p>
            <p className="mp-meta" style={{ marginTop: 18 }}>
              <Link href="/forgot-password" className="mp-link">Request a new link</Link>
              {' '}&middot;{' '}
              <Link href="/login" className="mp-link">Back to sign in</Link>
            </p>
          </div>
        ) : (
          <ResetPasswordForm error={formError} />
        )}
      </div>
    </main>
  )
}
