import { requireAllowedUser } from '@/lib/auth/guard'
import { BuildingStatus } from '@/components/building-status'
import { BrandSeed } from '@/components/brand-seed'

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
  await requireAllowedUser()

  const { from } = await searchParams
  const onboarding = from === 'onboarding'

  return (
    <main className="mp-stage">
      <div style={{ display: 'grid', gap: 18, justifyItems: 'center', textAlign: 'center' }}>
        <BrandSeed size={188} mark={66} />
        <div>
          <p className="mp-eyebrow mp-eyebrow--accent">{onboarding ? 'Welcome' : 'Mining'}</p>
          <h1 className="mp-h2" style={{ marginTop: 8 }}>
            {onboarding ? 'Building your initial context' : 'Building your memory'}
          </h1>
        </div>
        <BuildingStatus onboarding={onboarding} />
      </div>
    </main>
  )
}
