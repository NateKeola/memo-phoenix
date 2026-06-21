'use client'

import dynamic from 'next/dynamic'

// Lazy-load the interview surface so the ElevenLabs voice SDK (~125 kB) is a
// separate chunk, not in this route's initial First-Load JS. ssr:false because the
// SDK is browser-only.
const InterviewWidget = dynamic(
  () => import('@/components/interview-widget').then((m) => m.InterviewWidget),
  {
    ssr: false,
    loading: () => <p style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>Loading...</p>,
  }
)

export default function StartInterviewPage() {
  return <InterviewWidget />
}
