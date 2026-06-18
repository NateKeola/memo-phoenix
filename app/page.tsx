import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { CaptureMenu } from '@/components/capture-menu'

export default async function HomePage() {
  const supabase = await createClient()

  // Validate the user independently rather than trusting the middleware redirect.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Memo Phoenix</h1>
      <p>Signed in as {user.email}</p>
      <CaptureMenu />
      <p style={{ margin: '16px 0' }}>
        <Link href="/ask">Ask your corpus &rarr;</Link>
      </p>
      <form action="/auth/signout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  )
}
