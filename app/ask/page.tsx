import { Chat } from '@/components/chat'
import { requireAllowedUser } from '@/lib/auth/guard'
import { PageHeader } from '@/components/page-header'

// The ask/chat surface. Always accessible to an allowlisted signed-in user (no
// baseline gate, by decision).
export default async function AskPage() {
  await requireAllowedUser()

  return (
    <main className="mp-page">
      <PageHeader back="/" backLabel="Home" />
      <h1 className="mp-h1">Ask</h1>
      <p className="mp-sub">
        Answers from your own knowledge graph, with sources. Try &ldquo;what am I working on&rdquo;,
        &ldquo;who is Karalea&rdquo;, &ldquo;what do I owe people&rdquo;, or &ldquo;what is coming up&rdquo;.
      </p>
      <Chat />
    </main>
  )
}
