import { PageHeader } from '@/components/page-header'
import { BottomNav } from '@/components/bottom-nav'
import { Skel } from '@/components/skeleton'

export default function Loading() {
  return (
    <main className="mp-page">
      <PageHeader back="/" backLabel="Home" />
      <h1 className="mp-h1">Ask</h1>
      <Skel w="90%" h={14} style={{ marginTop: 6 }} />
      <div style={{ marginTop: 24 }}><Skel w="100%" h={46} r={12} /></div>
      <BottomNav />
    </main>
  )
}
