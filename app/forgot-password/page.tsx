import Link from 'next/link'
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form'

export const dynamic = 'force-dynamic'

// Self-service password recovery, linked from the sign-in screen. The user enters
// their email and Supabase sends them a reset link (custom SMTP is configured, so
// delivery is reliable); no admin is involved. The link lands on /reset-password
// where they set a new password. The form is enumeration-safe (the action returns the
// same neutral message whether or not the email is registered).
export default function ForgotPasswordPage() {
  return (
    <main className="mp-stage">
      <div>
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <span
            className="mp-mark"
            style={{ display: 'block', width: 64, height: 64, margin: '0 auto 14px' }}
            aria-hidden
          />
          <h1 className="mp-h2">Forgot your password?</h1>
          <p className="mp-sub" style={{ marginTop: 6 }}>
            Enter your email and we will send you a link to set a new one.
          </p>
        </div>

        <ForgotPasswordForm />

        <p className="mp-meta" style={{ marginTop: 22, textAlign: 'center' }}>
          <Link href="/login" className="mp-link">Back to sign in</Link>
        </p>
      </div>
    </main>
  )
}
