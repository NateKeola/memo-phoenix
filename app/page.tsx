import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { CaptureMenu } from '@/components/capture-menu'
import { isOperator } from '@/lib/auth/operator'

export default async function HomePage() {
  const supabase = await createClient()

  // Validate the user independently rather than trusting the middleware redirect.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Show a "building your memory" banner if a mine is in flight (e.g. just after
  // onboarding), so the app is never a silent empty shell.
  const { data: activeRun } = await supabase
    .from('miner_runs')
    .select('id, status')
    .eq('user_id', user.id)
    .eq('status', 'running')
    .limit(1)
    .maybeSingle()

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Memo Phoenix</h1>
      <p>Signed in as {user.email}</p>
      {activeRun ? (
        <p style={{ margin: '12px 0', background: '#fdf6e3', padding: 12, borderRadius: 8 }}>
          Building your memory from your conversation. <Link href="/building">See progress &rarr;</Link>
        </p>
      ) : null}
      <CaptureMenu />
      <p style={{ margin: '16px 0' }}>
        <Link href="/ask">Ask your corpus &rarr;</Link>
      </p>
      <p style={{ margin: '16px 0' }}>
        <Link href="/people">People &rarr;</Link>
      </p>
      <p style={{ margin: '16px 0' }}>
        <Link href="/companion">Today &rarr;</Link>
      </p>
      <p style={{ margin: '16px 0' }}>
        <Link href="/miner">Memory &rarr;</Link>
      </p>
      {isOperator(user) ? (
        <p style={{ margin: '16px 0' }}>
          <Link href="/admin">Invites (operator) &rarr;</Link>
        </p>
      ) : null}
      <form action="/auth/signout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  )
}
