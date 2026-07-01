import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

type CookieToSet = { name: string; value: string; options: CookieOptions }

// Refreshes the auth session on every matched request and gates access. Calls
// supabase.auth.getUser(), which revalidates the JWT against the auth server
// (do not use getSession() here), satisfying JWT-validation on every route.
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Do not run code between createServerClient and getUser().
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname
  // /api routes self-handle auth and return JSON status (401), so don't redirect
  // them to /login; the session is still refreshed above for the route handler.
  // /not-authorized is reachable by a signed-in but not-allowlisted user (the route
  // guard sends them there), so it must not be bounced by the gates below.
  // /reset-password and /forgot-password are reachable WITHOUT a normal session:
  // a recovery link lands on /reset-password (its page handles the no-session case
  // by showing a clean "expired" state), and a locked-out user needs /forgot-password.
  // Marking them public also exempts them from the onboarding gate below.
  const isPublic =
    path === '/login' ||
    path === '/not-authorized' ||
    path === '/forgot-password' ||
    path === '/reset-password' ||
    path.startsWith('/auth') ||
    path.startsWith('/api')

  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // Invite-only onboarding gate. A freshly invited user (app_metadata.invited, set
  // by the admin invite path) who has not finished onboarding is sent to the
  // onboarding interview before the rest of the app. The flag rides in the JWT, so
  // this costs no DB query. The pre-existing operator has no `invited` flag and is
  // never affected. Exempt /onboarding (itself) and /building (the post-onboarding
  // wait) so we never loop while app_metadata.onboarded propagates.
  if (user && !isPublic && path !== '/onboarding' && path !== '/building') {
    const meta = (user.app_metadata ?? {}) as { invited?: boolean; onboarded?: boolean }
    if (meta.invited === true && meta.onboarded !== true) {
      const url = request.nextUrl.clone()
      url.pathname = '/onboarding'
      url.search = ''
      return NextResponse.redirect(url)
    }
  }

  // Must return supabaseResponse unchanged so refreshed cookies reach the browser.
  return supabaseResponse
}
