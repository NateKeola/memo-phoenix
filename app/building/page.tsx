import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { BuildingStatus } from '@/components/building-status'

export const dynamic = 'force-dynamic'

// Shown right after onboarding: the new user's graph is being built off-machine.
// Never a silent empty app; this explains the wait and reports progress.
export default async function BuildingPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 640 }}>
      <h1>Building your memory</h1>
      <BuildingStatus />
    </main>
  )
}
