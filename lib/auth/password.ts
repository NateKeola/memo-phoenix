// Password policy, shared between the server action that ENFORCES it and the
// signup form that shows a live checklist. Deliberately NOT server-only and with
// no server imports, so the client form can import the same checks (one source of
// truth: the UI hint and the server gate can never drift apart).
//
// Policy: at least 8 characters, at least one letter, one number, one special
// character. The server action is the authority; the checklist is UX.

export type PasswordCheck = { id: string; label: string; test: (pw: string) => boolean }

export const PASSWORD_CHECKS: PasswordCheck[] = [
  { id: 'len', label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { id: 'letter', label: 'A letter', test: (p) => /[A-Za-z]/.test(p) },
  { id: 'number', label: 'A number', test: (p) => /[0-9]/.test(p) },
  { id: 'special', label: 'A special character', test: (p) => /[^A-Za-z0-9]/.test(p) },
]

export type PasswordResult = { ok: true } | { ok: false; error: string }

// Enforce the policy server-side. Returns a clear, user-facing message naming what
// is missing. Called by the create-account action before any account is minted.
export function validatePassword(pw: string): PasswordResult {
  const failed = PASSWORD_CHECKS.filter((c) => !c.test(pw))
  if (failed.length === 0) return { ok: true }
  return {
    ok: false,
    error: 'Password needs ' + failed.map((f) => f.label.toLowerCase()).join(', ') + '.',
  }
}
