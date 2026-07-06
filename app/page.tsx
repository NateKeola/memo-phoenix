import Link from 'next/link'
import { CaptureMenu } from '@/components/capture-menu'
import { BottomNav } from '@/components/bottom-nav'
import { BrandSeed } from '@/components/brand-seed'
import { isOperator } from '@/lib/auth/operator'
import { requireAllowedUser } from '@/lib/auth/guard'
import { getProfile } from '@/lib/profile'

export default async function HomePage() {
  // Authenticate + enforce the allowlist (the security boundary; middleware is UX
  // only). Returns the RLS client + user, reused for the reads below.
  const { supabase, user } = await requireAllowedUser()

  // In one parallel batch: is a mine in flight (the "building" banner), how many
  // captures the user has yet (so a brand-new user gets a get-started hint rather
  // than a bare nav), and the people count for the home stat line. All RLS-scoped
  // read-only counts; the app is never a silent, unexplained empty shell.
  const [{ data: activeRun }, { count: captureCount }, { count: peopleCount }, profile] = await Promise.all([
    supabase.from('miner_runs').select('id, status').eq('user_id', user.id).eq('status', 'running').limit(1).maybeSingle(),
    supabase.from('captures').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
    supabase.from('canonical_people').select('id', { count: 'exact', head: true }).eq('user_id', user.id).is('valid_to', null),
    getProfile(supabase, user),
  ])
  const notes = captureCount ?? 0
  const people = peopleCount ?? 0
  const isNew = notes === 0 && !activeRun
  const initial = profile.initial

  return (
    <main className="mp-page" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header className="mp-top">
        <Link href="/settings" aria-label="Profile and settings" title="Profile">
          <span className="mp-avatar" aria-hidden>
            {profile.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={profile.avatarUrl} alt="" />
            ) : (
              initial
            )}
          </span>
        </Link>
        <span style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {isOperator(user) ? (
            <Link href="/admin" className="mp-meta" style={{ color: 'var(--txt-muted)' }}>Invites</Link>
          ) : null}
          <Link href="/settings" className="mp-meta" style={{ color: 'var(--txt-muted)' }}>Settings</Link>
          <form action="/auth/signout" method="post">
            <button type="submit" className="mp-meta" style={{ border: 0, background: 'none', cursor: 'pointer', color: 'var(--txt-faint)' }}>
              Sign out
            </button>
          </form>
        </span>
      </header>

      <h1 className="mp-h1">Home</h1>

      {activeRun ? (
        <p className="mp-banner mp-rise" style={{ marginTop: 16 }}>
          Building your memory from your conversation. <Link href="/building">See progress &rarr;</Link>
        </p>
      ) : null}
      {isNew ? (
        <p className="mp-sub" style={{ marginTop: 14 }}>
          Welcome. Tap the <span style={{ color: 'var(--accent)' }}>+</span> to add your first note or start
          an interview, and Memo begins building your memory.
        </p>
      ) : null}

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          paddingBottom: 48,
        }}
      >
        <BrandSeed />
        <div className="mp-stat" style={{ marginTop: 24 }}>
          {people} {people === 1 ? 'person' : 'people'} &middot; {notes} {notes === 1 ? 'note' : 'notes'}
        </div>
      </div>

      <CaptureMenu />
      <BottomNav />
    </main>
  )
}
