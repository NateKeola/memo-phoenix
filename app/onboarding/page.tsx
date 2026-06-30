import { redirect } from 'next/navigation'
import { requireAllowedUser } from '@/lib/auth/guard'
import { OnboardingInterview } from '@/components/onboarding-interview'

export const dynamic = 'force-dynamic'

// First-run onboarding. A new invited user lands here before the rest of the app
// (the middleware gate forces it until app_metadata.onboarded is set). It is a
// warm first conversation that seeds their graph from minute one.
export default async function OnboardingPage() {
  const { user } = await requireAllowedUser()

  // Already onboarded? Don't trap them here.
  if ((user.app_metadata as { onboarded?: boolean } | undefined)?.onboarded === true) {
    redirect('/')
  }

  const name = (user.app_metadata as { name?: string } | undefined)?.name || user.email?.split('@')[0]

  return (
    <main className="mp-page mp-page--flush" style={{ maxWidth: 600 }}>
      <p className="mp-eyebrow mp-eyebrow--accent" style={{ marginTop: 8 }}>Welcome</p>
      <h1 className="mp-h1" style={{ marginTop: 10 }}>Welcome to Memo{name ? `, ${name}` : ''}</h1>
      <p className="mp-sub">
        Memo is a companion that remembers your life and grows with you. To start, have a short, easy
        conversation so it can get to know you: the people who matter, what you do, what you are
        working on, what you care about. There are no wrong answers, and you can always add more later.
      </p>
      <p className="mp-meta" style={{ marginTop: 10 }}>This is a voice conversation, so it needs your microphone.</p>
      <OnboardingInterview />
    </main>
  )
}
