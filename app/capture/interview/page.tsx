import Link from 'next/link'

// Stub only. The conversational ElevenLabs interview agent (briefing injection,
// session minting) is PR3. No agent logic here.
export default function StartInterviewPage() {
  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 560 }}>
      <p><Link href="/">&larr; Home</Link></p>
      <h1>Start interview</h1>
      <p>The conversational interview agent is coming in PR3. This is a placeholder.</p>
    </main>
  )
}
