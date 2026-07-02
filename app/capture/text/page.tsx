import { PageHeader } from '@/components/page-header'
import { requireAllowedUser } from '@/lib/auth/guard'
import { CaptureTextForm } from '@/components/capture-text-form'

export default async function AddTextPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>
}) {
  await requireAllowedUser()
  const { ok, error } = await searchParams

  return (
    <main className="mp-page mp-page--flush" style={{ maxWidth: 560 }}>
      <PageHeader back="/" backLabel="Home" />
      <p className="mp-eyebrow">New note</p>
      <h1 className="mp-h1" style={{ marginTop: 8 }}>Add text</h1>
      <p className="mp-sub">A quick note. It is captured and folds into your graph on the next miner run.</p>

      {ok ? <p className="mp-ok mp-rise" style={{ marginTop: 14 }}>Captured.</p> : null}
      {error ? <p className="mp-bad mp-rise" style={{ marginTop: 14 }}>{error}</p> : null}

      <CaptureTextForm />
    </main>
  )
}
