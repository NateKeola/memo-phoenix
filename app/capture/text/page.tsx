import { PageHeader } from '@/components/page-header'
import { requireAllowedUser } from '@/lib/auth/guard'
import { addTextCapture } from './actions'

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

      <form action={addTextCapture} style={{ display: 'grid', gap: 12, marginTop: 18 }}>
        <textarea name="body" rows={8} placeholder="What's on your mind?" required className="mp-textarea" />
        <input
          name="routing_hint"
          type="text"
          placeholder="optional hint (e.g. work, personal, gift list)"
          className="mp-input"
        />
        <button type="submit" className="mp-btn mp-btn--primary mp-btn--block">Capture</button>
      </form>
    </main>
  )
}
