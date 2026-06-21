'use client'

import dynamic from 'next/dynamic'

// Lazy-load the onboarding interview so the ElevenLabs voice SDK (~125 kB) is a
// separate chunk, not in the onboarding route's initial First-Load JS (the first
// screen a brand-new user hits). ssr:false because the SDK is browser-only.
const OnboardingInterview = dynamic(
  () => import('@/components/onboarding-interview').then((m) => m.OnboardingInterview),
  {
    ssr: false,
    loading: () => <p>Loading...</p>,
  }
)

export function OnboardingInterviewLoader() {
  return <OnboardingInterview />
}
