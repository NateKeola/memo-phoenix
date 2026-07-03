import { BottomNav } from '@/components/bottom-nav'
import { BrandSeed } from '@/components/brand-seed'
import { Skel } from '@/components/skeleton'

// Instant shell for the home tab: the real chrome (avatar bar, title, the spinning
// seed, the nav) paints immediately; only the stat line shimmers until it streams.
export default function Loading() {
  return (
    <main className="mp-page" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header className="mp-top">
        <span className="mp-avatar" aria-hidden />
        <Skel w={56} h={13} />
      </header>
      <h1 className="mp-h1">Home</h1>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingBottom: 48 }}>
        <BrandSeed />
        <Skel w={150} h={15} style={{ marginTop: 24 }} />
      </div>
      <BottomNav />
    </main>
  )
}
