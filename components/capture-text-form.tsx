'use client'

import { useFormStatus } from 'react-dom'
import { addTextCapture } from '@/app/capture/text/actions'

// The text-capture form with a real PENDING state: the submit button disables and
// relabels while the server action runs, so a slow submit cannot be double-clicked
// into two captures. (The server-side content dedup in lib/captures.ts is the
// second line of defense; this is the first. The live double-submits happened on
// this exact form when it had neither.)
function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button type="submit" className="mp-btn mp-btn--primary mp-btn--block" disabled={pending}>
      {pending ? 'Capturing...' : 'Capture'}
    </button>
  )
}

export function CaptureTextForm() {
  return (
    <form action={addTextCapture} style={{ display: 'grid', gap: 12, marginTop: 18 }}>
      <textarea name="body" rows={8} placeholder="What's on your mind?" required className="mp-textarea" />
      <input
        name="routing_hint"
        type="text"
        placeholder="optional hint (e.g. work, personal, gift list)"
        className="mp-input"
      />
      <SubmitButton />
    </form>
  )
}
