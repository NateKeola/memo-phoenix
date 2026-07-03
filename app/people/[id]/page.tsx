import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireAllowedUser } from '@/lib/auth/guard'
import { duplicateCandidates, getPersonDetail, listPeople, type RetrievalDeps } from '@/lib/people'
import { PersonCorrections } from '@/components/person-corrections'
import { ContextAdder } from '@/components/context-adder'
import { PageHeader } from '@/components/page-header'

export const dynamic = 'force-dynamic'

function field(data: Record<string, unknown>, key: string): string | null {
  const v = data[key]
  return typeof v === 'string' && v.trim() ? v : null
}

// One person: who they are, what is tied to them, provenance, and the correction
// controls (rename, merge).
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { supabase, user } = await requireAllowedUser()

  const deps: RetrievalDeps = { supabase, userId: user.id }
  const person = await getPersonDetail(deps, id)
  if (!person) notFound()

  const aliases = Array.isArray(person.data.aliases)
    ? (person.data.aliases as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  // Fetch the people list ONCE and reuse it for the duplicate-candidate scoring,
  // instead of listPeople running twice (it also ran inside duplicateCandidates).
  const allPeople = await listPeople(deps)
  const candidates = await duplicateCandidates(deps, { id: person.id, name: person.name, aliases }, allPeople)

  const relationship = field(person.data, 'relationship')
  const role = field(person.data, 'role')
  const closeness = field(person.data, 'closeness')
  const workOrPersonal = field(person.data, 'work_or_personal')
  const tags = [role, closeness, workOrPersonal].filter(Boolean) as string[]
  const initial = (person.name ?? '?').trim().charAt(0).toUpperCase() || '?'

  return (
    <main className="mp-page mp-page--flush">
      <PageHeader back="/people" backLabel="People" />

      <header style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span className="mp-avatar mp-avatar--lg" aria-hidden>{initial}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 className="mp-h2" style={{ margin: 0 }}>{person.name ?? '(unnamed)'}</h1>
            <ContextAdder targetKind="person" targetId={person.id} label={person.name ?? 'this person'} source="person_detail" showInterview />
          </div>
          {relationship ? (
            <div style={{ marginTop: 5, fontStyle: 'italic', color: 'var(--accent)', fontSize: 16 }}>{relationship}</div>
          ) : null}
        </div>
      </header>

      {person.pendingRename ? (
        <p className="mp-meta" style={{ color: 'var(--accent-deep)', marginTop: 12 }}>This rename takes effect on the next miner run.</p>
      ) : null}

      <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {tags.length > 0 ? (
          tags.map((t) => <span key={t} className={`mp-tag${t === 'work' ? ' mp-tag--accent' : ''}`}>{t}</span>)
        ) : (
          !relationship ? <span className="mp-meta">No tags yet</span> : null
        )}
      </div>

      {aliases.length > 0 ? <p className="mp-meta" style={{ marginTop: 12 }}>Also known as: {aliases.join(', ')}</p> : null}
      {person.summary ? <p className="mp-sub" style={{ marginTop: 12 }}>{person.summary}</p> : null}

      {person.provenance.length > 0 ? (
        <p className="mp-meta" style={{ marginTop: 12 }}>
          First mentioned in your {person.provenance[0].mode}
          {person.provenance[0].date ? ` on ${person.provenance[0].date}` : ''}
          {person.provenance.length > 1 ? ` (and ${person.provenance.length - 1} more)` : ''}.
        </p>
      ) : null}

      <section style={{ marginTop: 26 }}>
        <p className="mp-eyebrow">Relationships</p>
        {person.relationships.length === 0 ? (
          <p className="mp-meta" style={{ marginTop: 10 }}>None recorded.</p>
        ) : (
          <ul className="mp-list" style={{ marginTop: 10, display: 'grid', gap: 8 }}>
            {person.relationships.map((e, i) => (
              <li key={i} className="mp-row__title" style={{ fontSize: 16 }}>
                {e.summary ?? `${e.relation ?? 'related to'} ${e.other.label ?? e.other.id}`}
                {e.other.label && e.other.type === 'person' ? (
                  <Link href={`/people/${e.other.id}`} className="mp-link" style={{ marginLeft: 6, fontSize: 13 }}>
                    view
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: 22 }}>
        <p className="mp-eyebrow">Commitments</p>
        {person.commitments.length === 0 ? (
          <p className="mp-meta" style={{ marginTop: 10 }}>None recorded.</p>
        ) : (
          <ul className="mp-list" style={{ marginTop: 10, display: 'grid', gap: 8 }}>
            {person.commitments.map((c) => (
              <li key={c.id} className="mp-row__title" style={{ fontSize: 16 }}>
                {c.label}
                {c.due ? <span style={{ color: 'var(--txt-faint)' }}> (due {String(c.due)})</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <PersonCorrections
        person={{ id: person.id, name: person.name }}
        candidates={candidates.map((c) => ({ id: c.id, name: c.name }))}
        allPeople={allPeople.map((p) => ({ id: p.id, name: p.name }))}
      />
    </main>
  )
}
