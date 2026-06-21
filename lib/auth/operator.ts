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

export type SiteUrlResult = { url: string; warning?: string } | { error: string }

function isLocalOrigin(u?: string): boolean {
  return !u || /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(u)
}

// Resolve the base URL for links we mint (the invite redirect, the sign-in magic
// link). The invite redirect MUST be a real, reachable URL, or the invited person
// gets a dead localhost link. Resolution, in order:
//   1. NEXT_PUBLIC_SITE_URL (the configured deployed domain) - always preferred.
//   2. A real, non-localhost request origin (the deployed host on a real request).
//   3. In a DEPLOYED context (Vercel / production) with neither, REFUSE LOUDLY -
//      never silently emit a localhost link that looks fine and fails on click.
//   4. Only in genuine local development, fall back to localhost (with a warning).
export function resolveSiteUrl(requestOrigin?: string): SiteUrlResult {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, '')
  if (configured) return { url: configured }

  const origin = requestOrigin?.trim().replace(/\/$/, '')
  if (origin && !isLocalOrigin(origin)) return { url: origin }

  const deployed = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production'
  if (deployed) {
    return {
      error:
        'Site URL not configured: NEXT_PUBLIC_SITE_URL is unset and the request origin is local. ' +
        'Set NEXT_PUBLIC_SITE_URL to the deployed domain (and add it to the Supabase Auth Redirect URLs) before inviting.',
    }
  }
  return {
    url: origin || 'http://localhost:3000',
    warning: 'Using a localhost link (local development). Set NEXT_PUBLIC_SITE_URL to send invites that work for others.',
  }
}
