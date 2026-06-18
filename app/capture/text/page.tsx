import Link from 'next/link'
import { addTextCapture } from './actions'

export default async function AddTextPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>
}) {
  const { ok, error } = await searchParams

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 560 }}>
      <p><Link href="/">&larr; Home</Link></p>
      <h1>Add text</h1>
      {ok ? <p style={{ color: 'green' }}>Captured.</p> : null}
      {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}
      <form action={addTextCapture} style={{ display: 'grid', gap: 8 }}>
        <textarea name="body" rows={8} placeholder="What's on your mind?" required style={{ width: '100%' }} />
        <input
          name="routing_hint"
          type="text"
          placeholder="optional routing hint (e.g. work, personal, gift list)"
        />
        <button type="submit">Capture</button>
      </form>
    </main>
  )
}
