import { requireAllowedUser } from '@/lib/auth/guard'
import { MinerControl } from '@/components/miner-control'
import { PageHeader } from '@/components/page-header'

export const dynamic = 'force-dynamic'

// The miner-control surface (a dedicated page, the least-disruptive placement; see
// the PR for the settings-vs-tab-vs-widget options). RLS-scoped: the client only
// reads the signed-in user's own runs and captures.
export default async function MinerPage() {
  await requireAllowedUser()

  return (
    <main className="mp-page">
      <PageHeader back="/" backLabel="Home" />
      <h1 className="mp-h1">Memory</h1>
      <p className="mp-sub">
        Built by mining everything you have captured. Run it now, watch it work, and see what changed.
      </p>
      <MinerControl />
    </main>
  )
}
