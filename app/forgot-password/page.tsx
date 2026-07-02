import Link from 'next/link'
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form'

export const dynamic = 'force-dynamic'

// Self-service password recovery, linked from the sign-in screen. The user enters
// their email and gets a reset link that lands on /reset-password. Enumeration-safe
// (the action returns the same neutral message either way). The admin recovery link
// (/admin, no email involved) remains the fallback when email does not arrive.
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

        <p className="mp-meta" style={{ marginTop: 18, textAlign: 'center', maxWidth: 380 }}>
          Email can take a few minutes. If nothing arrives, contact your admin; they can generate a
          direct recovery link for you that does not depend on email at all.
        </p>

        <p className="mp-meta" style={{ marginTop: 18, textAlign: 'center' }}>
          <Link href="/login" className="mp-link">Back to sign in</Link>
        </p>
      </div>
    </main>
  )
}
