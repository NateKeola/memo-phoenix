import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isAllowed } from '@/lib/auth/guard'

export const dynamic = 'force-dynamic'

// Where the route guard sends an authenticated user whose email is NOT on the
// allowlist (never invited, or their invite was revoked). It shows a plain message
// and a sign-out, and crucially NO data. Self-correcting: an unauthenticated
// visitor is sent to /login, and a now-allowed user (e.g. just invited) is sent home.
export default async function NotAuthorizedPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (await isAllowed(user)) redirect('/')

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 480 }}>
      <h1>Not authorized</h1>
      <p>
        Your account ({user.email}) is not authorized to use this app. If you think this is a
        mistake, contact your admin to be added to the allowlist.
      </p>
      <form action="/auth/signout" method="post" style={{ marginTop: 16 }}>
        <button type="submit">Sign out</button>
      </form>
    </main>
  )
}
