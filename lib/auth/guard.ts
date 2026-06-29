import 'server-only'
import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { isOperator } from '@/lib/auth/operator'
import { isInvited } from '@/lib/invites'

// The auth + ALLOWLIST boundary. Every protected page, server action, and API
// route runs through one of these. This is the security boundary; the middleware
// is UX only (it redirects an unauthenticated visitor to /login and a half-onboarded
// user to /onboarding, but never trust it for authorization).
//
// Two independent checks on every protected entry point:
//   1. getUser() revalidates the JWT against the auth server (not getSession()),
//      satisfying JWT-validation on every route.
//   2. isAllowed() enforces the allowlist: the email must have an active (non-revoked)
//      invite, OR the caller is the single operator. Because this runs on EVERY
//      request, revoking an invite locks the user out immediately (the next request
//      lands on /not-authorized), not just at signup.

type RlsClient = Awaited<ReturnType<typeof createClient>>

// Is this user allowed into the app at all? The operator is always allowed (they
// were never "invited", they pre-exist the beta). Everyone else must hold an
// active invite (the invites table is the allowlist). The email is the join key.
export async function isAllowed(
  user: Pick<User, 'id' | 'email'> | null | undefined
): Promise<boolean> {
  if (!user) return false
  if (isOperator(user)) return true
  if (!user.email) return false
  return isInvited(user.email)
}

type Outcome =
  | { status: 'ok'; supabase: RlsClient; user: User }
  | { status: 'unauthenticated'; supabase: RlsClient }
  | { status: 'forbidden'; supabase: RlsClient; user: User }

// The shared primitive: authenticate + allowlist, returning a discriminated
// outcome. The thin wrappers below turn it into a redirect (pages/actions) or a
// JSON status (API routes).
async function checkAllowed(): Promise<Outcome> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { status: 'unauthenticated', supabase }
  if (!(await isAllowed(user))) return { status: 'forbidden', supabase, user }
  return { status: 'ok', supabase, user }
}

// For server components and redirect-style server actions. Redirects to /login when
// unauthenticated and /not-authorized when authenticated-but-not-allowlisted; never
// returns the data path to a disallowed caller. Returns the RLS client + user so
// the caller reuses the same authenticated client for its reads/writes.
export async function requireAllowedUser(): Promise<{ supabase: RlsClient; user: User }> {
  const r = await checkAllowed()
  if (r.status === 'unauthenticated') redirect('/login')
  if (r.status === 'forbidden') redirect('/not-authorized')
  return { supabase: r.supabase, user: r.user }
}

// For JSON-returning server actions that cannot redirect. Returns a discriminated
// result the caller maps onto its own response shape.
export type ActionAuth =
  | { ok: true; supabase: RlsClient; user: User }
  | { ok: false; reason: 'unauthenticated' | 'forbidden' }

export async function authorizeAction(): Promise<ActionAuth> {
  const r = await checkAllowed()
  if (r.status === 'ok') return { ok: true, supabase: r.supabase, user: r.user }
  return { ok: false, reason: r.status }
}

// For API route handlers. On failure returns a ready-to-return NextResponse
// (401 unauthenticated, 403 forbidden); on success returns the client + user.
// Usage:
//   const auth = await authorizeApiUser()
//   if ('error' in auth) return auth.error
//   const { supabase, user } = auth
export type ApiAuth =
  | { error: NextResponse; supabase?: undefined; user?: undefined }
  | { error?: undefined; supabase: RlsClient; user: User }

export async function authorizeApiUser(): Promise<ApiAuth> {
  const r = await checkAllowed()
  if (r.status === 'unauthenticated') {
    return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  }
  if (r.status === 'forbidden') {
    return { error: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  }
  return { supabase: r.supabase, user: r.user }
}
