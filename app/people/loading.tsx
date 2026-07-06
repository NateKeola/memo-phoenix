import { PageHeader } from '@/components/page-header'
import { Skel, SkelRows } from '@/components/skeleton'

export default function Loading() {
  return (
    <main className="mp-page">
      <PageHeader back="/" backLabel="Home" />
      <h1 className="mp-h1">People</h1>
      <Skel w="72%" h={14} style={{ marginTop: 6 }} />
      <SkelRows n={7} />
    </main>
  )
}
