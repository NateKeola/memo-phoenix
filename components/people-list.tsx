'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import type { PersonListItem } from '@/lib/people'
import { ContextAdder } from '@/components/context-adder'

// The contact sheet list with a client-side search filter. This is DISTINCT from the
// global corpus search in the bottom nav (Ask): this only narrows the already-loaded
// people list by name / alias / relationship / role, no query to the model or server.
export function PeopleList({ people }: { people: PersonListItem[] }) {
  const [q, setQ] = useState('')

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return people
    return people.filter((p) => {
      const hay = [p.name ?? '', p.relationship ?? '', p.role ?? '', ...p.aliases].join(' ').toLowerCase()
      return hay.includes(needle)
    })
  }, [people, q])

  return (
    <div>
      <input
        type="search"
        className="mp-input"
        placeholder="Search people by name, alias, or relationship"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search people"
        style={{ marginTop: 14 }}
      />

      {filtered.length === 0 ? (
        <p className="mp-meta" style={{ marginTop: 16 }}>
          {q.trim() ? `No people match "${q.trim()}".` : 'No people yet.'}
        </p>
      ) : (
        <ul className="mp-list" style={{ marginTop: 14 }}>
          {filtered.map((p) => {
            const initial = (p.name ?? '?').trim().charAt(0).toUpperCase() || '?'
            const isWork = p.work_or_personal === 'work'
            return (
              <li key={p.id} className="mp-row">
                <Link
                  href={`/people/${p.id}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0, color: 'inherit' }}
                >
                  <span className="mp-avatar mp-avatar--sm" aria-hidden>{initial}</span>
                  <span className="mp-row__body">
                    <span className="mp-row__title">
                      {p.name ?? '(unnamed)'}
                      {p.relationship ? <span style={{ color: 'var(--txt-muted)', fontSize: 14 }}> &middot; {p.relationship}</span> : null}
                      {p.pendingRename ? <span style={{ color: 'var(--accent-deep)', fontSize: 12 }}> (rename pending next sync)</span> : null}
                    </span>
                    {p.aliases.length > 0 ? <span className="mp-row__sub">also {p.aliases.join(', ')}</span> : null}
                  </span>
                </Link>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {p.work_or_personal ? (
                    <span className={`mp-tag${isWork ? ' mp-tag--accent' : ''}`}>{p.work_or_personal}</span>
                  ) : null}
                  <ContextAdder
                    targetKind="person"
                    targetId={p.id}
                    label={p.name ?? 'this person'}
                    source="people_list"
                    showInterview
                    compact
                  />
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
