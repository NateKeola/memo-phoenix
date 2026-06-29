import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireAllowedUser } from '@/lib/auth/guard'
import { duplicateCandidates, getPersonDetail, listPeople, type RetrievalDeps } from '@/lib/people'
import { PersonCorrections } from '@/components/person-corrections'
import { ContextAdder } from '@/components/context-adder'

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
  const [candidates, allPeople] = await Promise.all([
    duplicateCandidates(deps, { id: person.id, name: person.name, aliases }),
    listPeople(deps),
  ])

  const relationship = field(person.data, 'relationship')
  const role = field(person.data, 'role')
  const closeness = field(person.data, 'closeness')
  const workOrPersonal = field(person.data, 'work_or_personal')

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 720 }}>
      <p>
        <Link href="/people">&larr; People</Link>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>{person.name ?? '(unnamed)'}</h1>
        <ContextAdder targetKind="person" targetId={person.id} label={person.name ?? 'this person'} source="person_detail" showInterview />
      </div>
      {person.pendingRename ? (
        <p style={{ color: '#b07a14', fontSize: 13, marginTop: 0 }}>This rename takes effect on the next miner run.</p>
      ) : null}
      <div style={{ color: '#555', marginBottom: 12 }}>
        {[relationship, role, closeness, workOrPersonal].filter(Boolean).join(' / ') || 'No tags yet'}
      </div>
      {aliases.length > 0 ? <p style={{ fontSize: 13, color: '#999' }}>Also known as: {aliases.join(', ')}</p> : null}
      {person.summary ? <p>{person.summary}</p> : null}

      {person.provenance.length > 0 ? (
        <p style={{ fontSize: 13, color: '#777' }}>
          First mentioned in your {person.provenance[0].mode}
          {person.provenance[0].date ? ` on ${person.provenance[0].date}` : ''}
          {person.provenance.length > 1 ? ` (and ${person.provenance.length - 1} more)` : ''}.
        </p>
      ) : null}

      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 18 }}>Relationships</h2>
        {person.relationships.length === 0 ? (
          <p style={{ color: '#999' }}>None recorded.</p>
        ) : (
          <ul style={{ display: 'grid', gap: 4, paddingLeft: 18 }}>
            {person.relationships.map((e, i) => (
              <li key={i}>
                {e.summary ?? `${e.relation ?? 'related to'} ${e.other.label ?? e.other.id}`}
                {e.other.label && e.other.type === 'person' ? (
                  <Link href={`/people/${e.other.id}`} style={{ marginLeft: 6, fontSize: 12 }}>
                    view
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 18 }}>Commitments</h2>
        {person.commitments.length === 0 ? (
          <p style={{ color: '#999' }}>None recorded.</p>
        ) : (
          <ul style={{ display: 'grid', gap: 4, paddingLeft: 18 }}>
            {person.commitments.map((c) => (
              <li key={c.id}>
                {c.label}
                {c.due ? <span style={{ color: '#777' }}> (due {String(c.due)})</span> : null}
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
