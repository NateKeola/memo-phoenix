import { PageHeader } from '@/components/page-header'
import { BottomNav } from '@/components/bottom-nav'
import { Skel } from '@/components/skeleton'

export default function Loading() {
  return (
    <main className="mp-page">
      <PageHeader back="/" backLabel="Home" />
      <h1 className="mp-h1">Memory</h1>
      <Skel w="80%" h={14} style={{ marginTop: 6 }} />
      <div className="mp-card" style={{ marginTop: 18 }}>
        <Skel w="45%" h={16} />
        <Skel w="100%" h={40} r={10} style={{ marginTop: 16 }} />
      </div>
    </main>
  )
}
