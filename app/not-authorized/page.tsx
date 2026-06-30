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
    <main className="mp-stage">
      <div style={{ textAlign: 'center' }}>
        <h1 className="mp-h2">Not authorized</h1>
        <p className="mp-sub" style={{ marginTop: 10 }}>
          Your account ({user.email}) is not authorized to use this app. If you think this is a
          mistake, contact your admin to be added to the allowlist.
        </p>
        <form action="/auth/signout" method="post" style={{ marginTop: 22 }}>
          <button type="submit" className="mp-btn mp-btn--ghost">Sign out</button>
        </form>
      </div>
    </main>
  )
}
