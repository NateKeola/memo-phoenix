import { requireAllowedUser } from '@/lib/auth/guard'
import { listPeople } from '@/lib/people'
import { PeopleList } from '@/components/people-list'
import { PageHeader } from '@/components/page-header'

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
        <PeopleList people={people} />
      )}
    </main>
  )
}
