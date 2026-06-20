import 'server-only'
import type { User } from '@supabase/supabase-js'

// The operator gate. A single-operator allowlist, NOT a role system: B2 builds an
// invite-only beta of ~5 users, and exactly one of them (the operator) may invite
// others. Identity is config, not data: MEMO_ADMIN_EMAIL names the operator, with
// MEMO_USER_ID as a fallback (the single pre-existing account from before B2).
//
// This deliberately avoids a roles/teams table (out of scope). If the beta ever
// needs more than one operator, this becomes a column; for now it is an env value.
export function isOperator(user: Pick<User, 'id' | 'email'> | null | undefined): boolean {
  if (!user) return false
  const adminEmail = process.env.MEMO_ADMIN_EMAIL?.trim().toLowerCase()
  if (adminEmail && user.email && user.email.trim().toLowerCase() === adminEmail) return true
  const adminId = process.env.MEMO_USER_ID?.trim()
  if (adminId && user.id === adminId) return true
  return false
}

// Base URL for links we mint (invite redirect targets, etc.). Prefer an explicit
// configured site URL; fall back to the request's own origin so local dev works
// without extra config.
export function siteUrl(requestOrigin?: string): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, '')
  if (configured) return configured
  if (requestOrigin) return requestOrigin.replace(/\/$/, '')
  return 'http://localhost:3000'
}
