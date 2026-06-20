import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { BuildingStatus } from '@/components/building-status'

export const dynamic = 'force-dynamic'

// Shown right after a mine is kicked off. Two framings share one screen:
//   - onboarding (?from=onboarding): "Building your initial context" for a brand-new
//     user, mined in front of them so the app is populated on first view;
//   - general: the post-capture "building your memory" status.
export default async function BuildingPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { from } = await searchParams
  const onboarding = from === 'onboarding'

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 640 }}>
      <h1>{onboarding ? 'Building your initial context' : 'Building your memory'}</h1>
      <BuildingStatus onboarding={onboarding} />
    </main>
  )
}
