import { Skel } from '@/components/skeleton'

export default function Loading() {
  return (
    <main className="mp-stage">
      <div style={{ display: 'grid', gap: 14, justifyItems: 'center' }}>
        <Skel w={64} h={64} r={32} />
        <Skel w={220} h={14} />
        <Skel w={160} h={12} />
      </div>
    </main>
  )
}
