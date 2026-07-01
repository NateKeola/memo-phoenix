import Link from 'next/link'
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form'

export const dynamic = 'force-dynamic'

// The "forgot your password" screen the sign-in page links to. In the invite-only
// beta, recovery is ADMIN-ASSISTED and does not depend on email delivery: the person
// asks their admin, who generates a recovery link in /admin and sends it to them.
// This screen states exactly what actually works, rather than a self-service form
// that would silently fail to deliver (the built-in Supabase email sender is
// rate-limited and unreliable). The optional self-service email form appears only
// when the operator has enabled it (RECOVERY_EMAIL_SELF_SERVICE, needs custom SMTP).
export default function ForgotPasswordPage() {
  const adminEmail = process.env.MEMO_ADMIN_EMAIL?.trim()
  const selfService = process.env.RECOVERY_EMAIL_SELF_SERVICE === '1'

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
        </div>

        <div className="mp-card">
          <p style={{ margin: 0 }}>
            While Memo is in a private beta, password recovery is handled by your admin. Ask them to
            send you a recovery link. You will open it and choose a new password. No waiting on
            email.
          </p>
          {adminEmail ? (
            <p className="mp-meta" style={{ marginTop: 12 }}>
              Your admin: <span style={{ color: 'var(--txt)' }}>{adminEmail}</span>
            </p>
          ) : null}
        </div>

        {selfService ? (
          <div style={{ marginTop: 18 }}>
            <p className="mp-eyebrow">Or email yourself a link</p>
            <ForgotPasswordForm />
          </div>
        ) : null}

        <p className="mp-meta" style={{ marginTop: 22, textAlign: 'center' }}>
          <Link href="/login" className="mp-link">Back to sign in</Link>
        </p>
      </div>
    </main>
  )
}
