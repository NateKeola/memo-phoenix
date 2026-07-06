'use client'

import { useEffect, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { importContacts } from '@/app/people/new/actions'

// Import contacts. The universal path is a vCard/CSV file upload (works everywhere).
// The Web Contacts API ("Pick from phone contacts") is a progressive enhancement
// shown ONLY where supported (Chrome on Android); it synthesizes a CSV from the
// picked names and submits through the SAME import action, so both paths share one
// parser + writer.
function Submit() {
  const { pending } = useFormStatus()
  return (
    <button type="submit" className="mp-btn mp-btn--ghost" disabled={pending}>
      {pending ? 'Importing...' : 'Import file'}
    </button>
  )
}

export function ContactImportForm() {
  const [supported, setSupported] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setSupported(typeof navigator !== 'undefined' && 'contacts' in navigator && typeof window !== 'undefined' && 'ContactsManager' in window)
  }, [])

  async function pickFromPhone() {
    setBusy(true)
    try {
      const nav = navigator as unknown as { contacts?: { select: (props: string[], opts: { multiple: boolean }) => Promise<Array<{ name?: string[] }>> } }
      const picked = (await nav.contacts?.select(['name'], { multiple: true })) ?? []
      const names = picked.flatMap((p) => p.name ?? []).map((n) => n.trim()).filter(Boolean)
      if (names.length === 0) return
      const csv = 'name\n' + names.map((n) => (/[",\n]/.test(n) ? `"${n.replace(/"/g, '""')}"` : n)).join('\n') + '\n'
      const fd = new FormData()
      fd.set('file', new File([csv], 'contacts.csv', { type: 'text/csv' }))
      await importContacts(fd) // the action redirects with the result
    } catch {
      // cancelled or unsupported at runtime; the file upload remains available
    } finally {
      setBusy(false)
    }
  }

  return (
    <form action={importContacts} style={{ display: 'grid', gap: 10 }}>
      <input type="file" name="file" accept=".vcf,.csv,text/vcard,text/csv" className="mp-input" aria-label="Contacts file" />
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Submit />
        {supported ? (
          <button type="button" className="mp-btn mp-btn--ghost" onClick={() => void pickFromPhone()} disabled={busy}>
            {busy ? 'Opening...' : 'Pick from phone contacts'}
          </button>
        ) : null}
      </div>
    </form>
  )
}
