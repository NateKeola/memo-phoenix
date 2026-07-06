import Link from 'next/link'
import { requireAllowedUser } from '@/lib/auth/guard'
import { isOperator } from '@/lib/auth/operator'
import { PageHeader } from '@/components/page-header'

export const dynamic = 'force-dynamic'

// Settings / profile. User-owned account metadata only (name, email, entry points);
// nothing here reads or writes canonical. The observability console link is shown
// ONLY to the operator (isOperator), matching the admin-only gate on the console
// itself; a regular user never sees it.
export default async function SettingsPage() {
  const { user } = await requireAllowedUser()
  const name = process.env.MEMO_USER_NAME || user.email?.split('@')[0] || 'You'
  const initial = (name || user.email || '?').trim().charAt(0).toUpperCase() || '?'
  const operator = isOperator(user)

  return (
    <main className="mp-page" style={{ maxWidth: 640 }}>
      <PageHeader back="/" backLabel="Home" />
      <h1 className="mp-h1">Settings</h1>

      {/* Profile */}
      <section className="mp-card" style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 16 }}>
        <span className="mp-avatar mp-avatar--lg" aria-hidden>{initial}</span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontWeight: 500, fontSize: 18 }}>{name}</span>
          <span className="mp-meta">{user.email}</span>
        </span>
      </section>

      {/* Your memory */}
      <section style={{ marginTop: 26 }}>
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
      <section style={{ marginTop: 26 }}>
        <p className="mp-eyebrow">Account</p>
        <form action="/auth/signout" method="post" style={{ marginTop: 10 }}>
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
