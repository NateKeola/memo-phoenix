'use client'

import { useFormStatus } from 'react-dom'
import { createContact } from '@/app/people/new/actions'

// Manual create contact. A plain form with a real pending state (so a slow submit
// cannot be double-clicked). The action writes a normal capture; the miner creates
// the person on the next mine.
function Submit() {
  const { pending } = useFormStatus()
  return (
    <button type="submit" className="mp-btn mp-btn--primary mp-btn--block" disabled={pending}>
      {pending ? 'Adding...' : 'Add contact'}
    </button>
  )
}

export function ContactCreateForm() {
  return (
    <form action={createContact} style={{ display: 'grid', gap: 12 }}>
      <input name="name" required maxLength={120} placeholder="Name" className="mp-input" aria-label="Name" />
      <input name="relationship" maxLength={80} placeholder="Relationship (optional, e.g. friend, coworker)" className="mp-input" aria-label="Relationship" />
      <textarea name="note" rows={3} maxLength={2000} placeholder="Note (optional)" className="mp-textarea" aria-label="Note" />
      <Submit />
    </form>
  )
}
