import { PageHeader } from '@/components/page-header'
import { Skel } from '@/components/skeleton'

export default function Loading() {
  return (
    <main className="mp-page">
      <PageHeader back="/" backLabel="Home" />
      <h1 className="mp-h1">Today</h1>
      <Skel w="85%" h={14} style={{ marginTop: 6 }} />
      <div style={{ display: 'grid', gap: 12, marginTop: 20 }}>
        <div className="mp-card"><Skel w="60%" h={16} /><Skel w="40%" h={12} style={{ marginTop: 10 }} /></div>
        <div className="mp-card"><Skel w="55%" h={16} /><Skel w="45%" h={12} style={{ marginTop: 10 }} /></div>
        <div className="mp-card"><Skel w="50%" h={16} /><Skel w="35%" h={12} style={{ marginTop: 10 }} /></div>
      </div>
    </main>
  )
}
