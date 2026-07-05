import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { isOperator } from '@/lib/auth/operator'
import { InviteForm } from '@/components/admin/invite-form'
import { RecoveryForm } from '@/components/admin/recovery-form'
import { PageHeader } from '@/components/page-header'
import { revokeInviteAction } from './actions'
import type { Invite } from '@/lib/invites'

export const dynamic = 'force-dynamic'

// Operator-only invite console. The page is gated to the single operator; there is
// deliberately NO public sign-up surface anywhere (signups stay disabled). This is
// the one place accounts are created, and only the operator can reach it.
export default async function AdminPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (!isOperator(user)) redirect('/')

  const { data } = await supabase
    .from('invites')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
  const invites = (data ?? []) as Invite[]

  return (
    <main className="mp-page mp-page--flush" style={{ maxWidth: 600 }}>
      <PageHeader back="/" backLabel="Home" />
      <h1 className="mp-h1">Invites</h1>
      <p className="mp-meta" style={{ marginTop: 6 }}><Link href="/admin/observability" className="mp-link">Open the observability console &rarr;</Link></p>
      <p className="mp-sub">
        Add a person to the allowlist by email. They then create their own account at the sign-in
        page with that email and a password. Only allowlisted addresses can register.
      </p>

      <InviteForm />

      <p className="mp-eyebrow" style={{ marginTop: 28 }}>Recover a password</p>
      <p className="mp-sub" style={{ marginTop: 4 }}>
        For an allowlisted person who forgot their password. Generates a link you send them
        directly (no email is sent); they open it and set a new password.
      </p>
      <RecoveryForm />

      <p className="mp-eyebrow" style={{ marginTop: 24 }}>Invited</p>
      {invites.length === 0 ? (
        <p className="mp-meta" style={{ marginTop: 10 }}>No invites yet.</p>
      ) : (
        <ul className="mp-list" style={{ marginTop: 8 }}>
          {invites.map((inv) => (
            <li key={inv.id} className="mp-row" style={{ justifyContent: 'space-between' }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ color: 'var(--txt)' }}>{inv.email}</span>{' '}
                <span className={`mp-tag ${statusTag(inv.status)}`} style={{ marginLeft: 4 }}>{inv.status}</span>
                {inv.note ? <span className="mp-meta" style={{ display: 'block', marginTop: 4 }}>{inv.note}</span> : null}
              </span>
              {inv.status !== 'revoked' ? (
                <form action={revokeInviteAction}>
                  <input type="hidden" name="id" value={inv.id} />
                  <button type="submit" className="mp-btn mp-btn--ghost" style={{ padding: '7px 13px', fontSize: 13 }}>
                    {inv.status === 'accepted' ? 'Remove' : 'Revoke'}
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

function statusTag(s: string): string {
  if (s === 'accepted') return 'mp-tag--ok'
  if (s === 'revoked') return ''
  return 'mp-tag--accent'
}
