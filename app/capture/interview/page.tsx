'use client'

import { InterviewWidget } from '@/components/interview-widget'

// Direct (static) import of the interview surface. PR #20 deferred the ElevenLabs
// SDK with next/dynamic(ssr:false) for a bundle win, but that ssr:false boundary
// remounted the live conversation after the first turn and tore down the WebSocket
// session (the agent stopped after one response). A working agent takes priority, so
// the SDK loads with the route again. See the decision log.
export default function StartInterviewPage() {
  return <InterviewWidget />
}
