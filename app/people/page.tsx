import Link from 'next/link'
import { requireAllowedUser } from '@/lib/auth/guard'
import { listPeople } from '@/lib/people'
import { ContextAdder } from '@/components/context-adder'
import { PageHeader } from '@/components/page-header'
import { BottomNav } from '@/components/bottom-nav'

export const dynamic = 'force-dynamic'

// The contact sheet (spec §11): the people in the graph, RLS-scoped, navigable.
export default async function PeoplePage() {
  const { supabase, user } = await requireAllowedUser()

  const people = await listPeople({ supabase, userId: user.id })

  return (
    <main className="mp-page">
      <PageHeader back="/" backLabel="Home" />
      <h1 className="mp-h1">People</h1>
      <p className="mp-sub">
        {people.length} {people.length === 1 ? 'person' : 'people'} in your graph. Tap one to see what is
        tied to them, or to fix a name or merge duplicates.
      </p>

      {people.length === 0 ? (
        <p className="mp-meta" style={{ marginTop: 20 }}>No people yet. They appear here as you capture and Memo mines your notes.</p>
      ) : (
        <ul className="mp-list" style={{ marginTop: 14 }}>
          {people.map((p) => {
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
      <BottomNav />
    </main>
  )
}
