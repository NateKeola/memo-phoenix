import Link from 'next/link'
import { requireAllowedUser } from '@/lib/auth/guard'
import { isOperator } from '@/lib/auth/operator'
import { PageHeader } from '@/components/page-header'
import { getProfile } from '@/lib/profile'
import { ProfileEditor } from '@/components/profile-editor'

export const dynamic = 'force-dynamic'

// The profile / settings screen. A centered, personalizable profile (photo + display
// name), then the memory links, the operator-only observability/invites links, and
// sign out. Everything here is user-owned metadata (user_profiles + the private
// avatars bucket); nothing reads or writes canonical. The observability link is shown
// ONLY to the operator (isOperator), matching the console's own admin-only gate.
export default async function SettingsPage() {
  const { supabase, user } = await requireAllowedUser()
  const profile = await getProfile(supabase, user)
  const operator = isOperator(user)

  return (
    <main className="mp-page" style={{ maxWidth: 520, marginLeft: 'auto', marginRight: 'auto' }}>
      <PageHeader back="/" backLabel="Home" />

      {/* Profile, centered */}
      <section style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginTop: 6 }}>
        <p className="mp-eyebrow">Profile</p>
        <div style={{ marginTop: 16, width: '100%' }}>
          <ProfileEditor
            displayName={profile.displayName}
            avatarUrl={profile.avatarUrl}
            initial={profile.initial}
            email={user.email ?? ''}
          />
        </div>
      </section>

      {/* Your memory */}
      <section style={{ marginTop: 32 }}>
        <p className="mp-eyebrow">Your memory</p>
        <ul className="mp-list" style={{ marginTop: 10 }}>
          <SettingLink href="/capture/interview" title="Talk with Memo" sub="Start an interview to add context in your own words." />
          <SettingLink href="/miner" title="Memory status" sub="See when Memo last built your graph and run it now." />
          <SettingLink href="/people" title="People" sub="The contact sheet: fix a name or merge duplicates." />
        </ul>
      </section>

      {/* Operator-only tools */}
      {operator ? (
        <section style={{ marginTop: 26 }}>
          <p className="mp-eyebrow">Operator</p>
          <ul className="mp-list" style={{ marginTop: 10 }}>
            <SettingLink href="/admin" title="Invites" sub="Invite and manage beta accounts." />
            <SettingLink href="/admin/observability" title="Observability" sub="Subsystem health, recent errors, and miner runs." />
          </ul>
        </section>
      ) : null}

      {/* Account */}
      <section style={{ marginTop: 28, display: 'flex', justifyContent: 'center' }}>
        <form action="/auth/signout" method="post">
          <button type="submit" className="mp-btn mp-btn--ghost">Sign out</button>
        </form>
      </section>
    </main>
  )
}

function SettingLink({ href, title, sub }: { href: string; title: string; sub: string }) {
  return (
    <li className="mp-row">
      <Link href={href} style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, color: 'inherit' }}>
        <span className="mp-row__title">{title}</span>
        <span className="mp-row__sub">{sub}</span>
      </Link>
      <span aria-hidden style={{ color: 'var(--txt-faint)' }}>&rsaquo;</span>
    </li>
  )
}
