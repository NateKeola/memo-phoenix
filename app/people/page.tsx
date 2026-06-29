import Link from 'next/link'
import { requireAllowedUser } from '@/lib/auth/guard'
import { listPeople } from '@/lib/people'
import { ContextAdder } from '@/components/context-adder'

export const dynamic = 'force-dynamic'

// The contact sheet (spec §11): the people in the graph, RLS-scoped, navigable.
export default async function PeoplePage() {
  const { supabase, user } = await requireAllowedUser()

  const people = await listPeople({ supabase, userId: user.id })

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 720 }}>
      <p>
        <Link href="/">&larr; Home</Link>
      </p>
      <h1>People</h1>
      <p style={{ color: '#666' }}>
        {people.length} {people.length === 1 ? 'person' : 'people'} in your graph. Tap one to see what is
        tied to them, or to fix a name or merge duplicates.
      </p>
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 6 }}>
        {people.map((p) => (
          <li
            key={p.id}
            style={{ border: '1px solid #eee', borderRadius: 8, padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}
          >
            <Link href={`/people/${p.id}`} style={{ textDecoration: 'none', color: 'inherit', flex: 1 }}>
              <strong>{p.name ?? '(unnamed)'}</strong>
              {p.pendingRename ? <span style={{ color: '#b07a14', fontSize: 12 }}> (rename pending next sync)</span> : null}
              {p.relationship ? <span style={{ color: '#555' }}> ({p.relationship})</span> : null}
              {p.work_or_personal ? (
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: 12,
                    color: '#777',
                    border: '1px solid #ddd',
                    borderRadius: 10,
                    padding: '1px 8px',
                  }}
                >
                  {p.work_or_personal}
                </span>
              ) : null}
              {p.aliases.length > 0 ? (
                <span style={{ display: 'block', fontSize: 12, color: '#999' }}>
                  also: {p.aliases.join(', ')}
                </span>
              ) : null}
            </Link>
            <ContextAdder
              targetKind="person"
              targetId={p.id}
              label={p.name ?? 'this person'}
              source="people_list"
              showInterview
              compact
            />
          </li>
        ))}
      </ul>
    </main>
  )
}
