'use server'

import { redirect } from 'next/navigation'
import { requireAllowedUser } from '@/lib/auth/guard'
import { writeCapture } from '@/lib/captures'
import { logEvent } from '@/lib/telemetry'
import { logObs, obsError } from '@/lib/observability'
import { parseContacts, manualContactBody, importCaptureBody, MAX_IMPORT } from '@/lib/contacts'

// Create + import contacts. A new contact NEVER writes the graph directly: it becomes
// a normal text capture (writeCapture, RLS-scoped, append-only) that the miner turns
// into a canonical person on the next mine. The miner stays the sole canonical writer.

const back = (q: string) => redirect(`/people/new?${q}`)

export async function createContact(formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '').trim()
  const relationship = String(formData.get('relationship') ?? '').trim() || null
  const note = String(formData.get('note') ?? '').trim() || null
  if (!name) back('error=' + encodeURIComponent('A name is required'))

  const { supabase, user } = await requireAllowedUser()
  try {
    await writeCapture(supabase, user.id, {
      mode: 'text',
      modality: 'text',
      body: manualContactBody({ name, relationship, note }),
      routingHint: 'contact',
    })
  } catch (e) {
    await logObs({ subsystem: 'capture_text', event: 'error', status: 'error', userId: user.id, ...obsError(e) })
    back('error=' + encodeURIComponent(e instanceof Error ? e.message.replace(/^\[capture\]\s*/, '') : String(e)))
  }
  await logEvent({ user_id: user.id, event_type: 'contact_create', name: 'manual', attrs: { has_relationship: Boolean(relationship), has_note: Boolean(note) } })
  back('created=' + encodeURIComponent(name))
}

export async function importContacts(formData: FormData): Promise<void> {
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) back('error=' + encodeURIComponent('Choose a .vcf or .csv file to import'))

  const { supabase, user } = await requireAllowedUser()
  const text = await (file as File).text()
  const all = parseContacts(text)
  if (all.length === 0) back('error=' + encodeURIComponent('No contacts found in that file (expected a vCard .vcf or a CSV with a name column)'))

  // Cap so an accidental huge file cannot append hundreds of permanent captures.
  const take = all.slice(0, MAX_IMPORT)
  let imported = 0
  let failed = 0
  for (const c of take) {
    try {
      await writeCapture(supabase, user.id, { mode: 'text', modality: 'text', body: importCaptureBody(c), routingHint: 'contact_import' })
      imported++
    } catch {
      failed++ // one bad row must not sink the whole import
    }
  }
  const skipped = all.length - take.length + failed
  await logEvent({ user_id: user.id, event_type: 'contact_import', name: 'file', attrs: { imported, skipped, found: all.length } })
  back(`imported=${imported}&skipped=${skipped}`)
}
