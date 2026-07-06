import { requireAllowedUser } from '@/lib/auth/guard'
import { PageHeader } from '@/components/page-header'
import { ContactCreateForm } from '@/components/contact-create'
import { ContactImportForm } from '@/components/contact-import'
import { MAX_IMPORT } from '@/lib/contacts'

export const dynamic = 'force-dynamic'

// Add a contact: manually, or by importing a vCard/CSV. Either way the contact enters
// through the normal capture pipeline (a text capture the miner incorporates on its
// next run); nothing is written to the canonical graph directly.
export default async function NewContactPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; imported?: string; skipped?: string; error?: string }>
}) {
  await requireAllowedUser()
  const { created, imported, skipped, error } = await searchParams
  const skippedN = Number(skipped) || 0

  return (
    <main className="mp-page" style={{ maxWidth: 560 }}>
      <PageHeader back="/people" backLabel="People" />
      <h1 className="mp-h1">Add a contact</h1>
      <p className="mp-sub">
        A new contact is captured and appears in People after Memo&apos;s next mine. Nothing is written to your graph
        directly.
      </p>

      {created ? (
        <p className="mp-ok mp-rise" style={{ marginTop: 14 }}>
          Added {decodeURIComponent(created)}. It appears in People after the next mine.
        </p>
      ) : null}
      {imported !== undefined ? (
        <p className="mp-ok mp-rise" style={{ marginTop: 14 }}>
          Imported {imported} contact{imported === '1' ? '' : 's'}
          {skippedN > 0 ? `, skipped ${skippedN}` : ''}. They appear in People after the next mine.
        </p>
      ) : null}
      {error ? (
        <p className="mp-bad mp-rise" style={{ marginTop: 14 }}>{error}</p>
      ) : null}

      <section style={{ marginTop: 24 }}>
        <p className="mp-eyebrow">New contact</p>
        <div style={{ marginTop: 10 }}>
          <ContactCreateForm />
        </div>
      </section>

      <section style={{ marginTop: 30 }}>
        <p className="mp-eyebrow">Import from a file</p>
        <p className="mp-meta" style={{ marginTop: 6, lineHeight: 1.5 }}>
          Importing directly from your phone&apos;s address book (the Web Contacts API) works only on Chrome for Android;
          iOS Safari and desktop browsers do not support it. Everywhere else, export a vCard (.vcf) or CSV from your
          contacts app and upload it here. Up to {MAX_IMPORT} contacts per import.
        </p>
        <div style={{ marginTop: 12 }}>
          <ContactImportForm />
        </div>
      </section>
    </main>
  )
}
