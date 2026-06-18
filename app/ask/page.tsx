import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Chat } from '@/components/chat'

// The ask/chat surface. Always accessible to the signed-in user (no baseline
// gate, by decision). Validates the user independently of the middleware.
export default async function AskPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

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
