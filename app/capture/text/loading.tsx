import { PageHeader } from '@/components/page-header'
import { Skel } from '@/components/skeleton'

export default function Loading() {
  return (
    <main className="mp-page mp-page--flush" style={{ maxWidth: 560 }}>
      <PageHeader back="/" backLabel="Home" />
      <p className="mp-eyebrow">New note</p>
      <h1 className="mp-h1" style={{ marginTop: 8 }}>Add text</h1>
      <Skel w="85%" h={14} style={{ marginTop: 6 }} />
      <div style={{ display: 'grid', gap: 12, marginTop: 18 }}>
        <Skel w="100%" h={150} r={12} />
        <Skel w="100%" h={44} r={10} />
      </div>
    </main>
  )
}
