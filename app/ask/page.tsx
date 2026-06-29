import Link from 'next/link'
import { Chat } from '@/components/chat'
import { requireAllowedUser } from '@/lib/auth/guard'

// The ask/chat surface. Always accessible to an allowlisted signed-in user (no
// baseline gate, by decision).
export default async function AskPage() {
  await requireAllowedUser()

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 720 }}>
      <p>
        <Link href="/">&larr; Home</Link>
      </p>
      <h1>Ask</h1>
      <p>
        Ask anything about your corpus. Answers are built from your own knowledge graph, with
        provenance. Try &ldquo;what am I working on&rdquo;, &ldquo;who is Karalea&rdquo;, &ldquo;what
        do I owe people&rdquo;, or &ldquo;what is coming up&rdquo;.
      </p>
      <Chat />
    </main>
  )
}
