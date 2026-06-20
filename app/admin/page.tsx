import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isOperator } from '@/lib/auth/operator'
import { InviteForm } from '@/components/admin/invite-form'
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
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 640 }}>
      <p>
        <Link href="/">&larr; Home</Link>
      </p>
      <h1>Invites</h1>
      <p>Invite a specific person by email. Only invited addresses can create an account.</p>

      <InviteForm />

      <h2 style={{ fontSize: 18, marginTop: 24 }}>Invited</h2>
      {invites.length === 0 ? (
        <p>No invites yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {invites.map((inv) => (
            <li
              key={inv.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
                borderBottom: '1px solid #eee',
                paddingBottom: 8,
              }}
            >
              <span>
                <strong>{inv.email}</strong>{' '}
                <span style={{ color: statusColor(inv.status), fontSize: 13 }}>({inv.status})</span>
                {inv.note ? <span style={{ color: '#888', fontSize: 13 }}> — {inv.note}</span> : null}
              </span>
              {inv.status !== 'revoked' ? (
                <form action={revokeInviteAction}>
                  <input type="hidden" name="id" value={inv.id} />
                  <button type="submit" style={{ fontSize: 13 }}>
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

function statusColor(s: string): string {
  if (s === 'accepted') return 'green'
  if (s === 'revoked') return '#999'
  return '#b8860b'
}
