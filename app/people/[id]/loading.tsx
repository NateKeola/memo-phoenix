import { PageHeader } from '@/components/page-header'
import { Skel } from '@/components/skeleton'

export default function Loading() {
  return (
    <main className="mp-page mp-page--flush">
      <PageHeader back="/people" backLabel="People" />
      <header style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Skel w={64} h={64} r={32} />
        <span style={{ display: 'grid', gap: 8, flex: 1 }}>
          <Skel w="50%" h={20} />
          <Skel w="32%" h={13} />
        </span>
      </header>
      <div style={{ display: 'grid', gap: 10, marginTop: 24 }}>
        <Skel w="90%" h={13} />
        <Skel w="80%" h={13} />
        <Skel w="60%" h={13} />
      </div>
    </main>
  )
}
