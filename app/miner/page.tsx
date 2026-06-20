import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { MinerControl } from '@/components/miner-control'

export const dynamic = 'force-dynamic'

// The miner-control surface (a dedicated page, the least-disruptive placement; see
// the PR for the settings-vs-tab-vs-widget options). RLS-scoped: the client only
// reads the signed-in user's own runs and captures.
export default async function MinerPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 680 }}>
      <p>
        <Link href="/">&larr; Home</Link>
      </p>
      <h1>Memory</h1>
      <p>Memo builds your memory by mining everything you have captured. Run it now, watch it work, and see what changed.</p>
      <MinerControl />
    </main>
  )
}
