# Supabase Auth Specification — Email + Password with Allowlisted Self-Signup

A reusable specification for adding user signup and login to a client application
backed by Supabase. Derived from a working production implementation. Hand this to
another project (or an AI coding assistant) as the auth design to implement.

> **Scope note.** This spec describes **email + password** auth with **allowlist-gated
> self-signup** — appropriate for internal tools, admin dashboards, and apps with a
> known, controlled set of users. If you instead need *open* public registration (anyone
> can join), see "Variant: open signup" at the end — but for anything exposing sensitive
> data, the allowlist model below is the safer default.

---

## 1. Goals & non-goals

**Goals**
- Users can **sign up** with email + password (self-service — no manual account creation).
- Users can **log in** with those credentials.
- Only **approved** emails may register (allowlist gate).
- Passwords meet a **strength policy**.
- Every protected route requires an authenticated, authorized session.
- No third-party email vendor required for normal login (see §7 on the one exception).

**Non-goals (for v1)**
- Social / OAuth logins.
- Multi-factor auth.
- Per-user data isolation via row-level security (this model assumes authorized users
  share the same data; add RLS policies separately if users must see different rows).
- Magic-link / passwordless (a valid alternative — noted in §9 — but not the default here).

---

## 2. Architecture overview

```
┌─────────────┐     1. signup/login (email+pw)      ┌──────────────────┐
│   Browser   │ ──────────────────────────────────> │  App server      │
│  (client)   │                                      │  (SSR backend)   │
└─────────────┘ <────────────────────────────────── └──────────────────┘
       │           4. session cookie set                     │
       │                                                      │ 2. allowlist check
       │                                                      │    (server-side)
       │                                                      ▼
       │                                              ┌──────────────────┐
       │           3. auth call                       │  Supabase Auth   │
       └────────────────────────────────────────────>│  (GoTrue)        │
                                                       └──────────────────┘
```

Two distinct concerns, kept separate:

1. **Authentication** — *"are you who you say you are?"* — handled by Supabase Auth
   (verifies the password, issues a session).
2. **Authorization** — *"are you allowed in?"* — handled by **your app server** checking
   the authenticated email against an **allowlist**. Supabase authenticating a user does
   NOT by itself mean they're authorized; the allowlist is the real gate.

**Critical principle:** the allowlist check is the security boundary, and it must run
**server-side** on every protected route. Client-side checks are for UX only and are
trivially bypassed.

---

## 3. Components to build

| Component | Responsibility |
|---|---|
| Supabase client (browser) | Holds the session; uses the **publishable/anon key** only. Never the service-role key. |
| Supabase client (server) | Reads/refreshes the session from cookies (SSR). Uses the SSR cookie pattern. |
| Allowlist module | A server-side list of approved emails (config or env-driven). Single source of truth for "who may register / access." |
| Auth actions | Server functions: `signUp`, `signIn`, `signOut`, (`requestPasswordReset`, `updatePassword`). |
| Password policy | Shared validator (client for UX feedback + server for enforcement). |
| Route guard | `requireAuthorizedUser()` — server-side; authenticates the session AND checks allowlist; redirects unauthorized users. |
| Middleware / proxy | Refreshes the session on requests and does an optimistic redirect for unauthenticated users (NOT the security boundary — see §6). |
| Login / signup / reset pages | The UI. |

---

## 4. The allowlist (authorization gate)

The allowlist is what makes self-signup safe: people register themselves, but only if
their email is pre-approved.

- Store as a server-side list — a config array (`ALLOWED_EMAILS`) or an env var
  (comma-separated). Easy for an admin to edit.
- Comparison must be **case-insensitive** and **trimmed** (normalize both sides).
- It is checked in **two** places (defense in depth):
  1. **At signup** — before an account is created. A non-allowlisted email gets a clear
     "this email isn't authorized — contact your admin" message and **no account is
     created**.
  2. **At every protected route** — after authentication, before granting access. An
     authenticated-but-not-allowlisted user (e.g. removed later) is sent to a
     "not authorized" screen, never to the data.

```
function isEmailAllowed(email):
    normalized = lowercase(trim(email))
    return normalized in normalizedAllowlist   # allowlist also lowercased/trimmed
```

---

## 5. Password policy

Enforce both client-side (immediate UX feedback) and server-side (the real enforcement —
never trust the client):

- Minimum **8 characters**
- At least one **letter**
- At least one **number**
- At least one **special character**

Show a live checklist on the signup/reset form (each rule ticks green as satisfied).
Reject on the server before the account is created or the password is changed.

Optionally enable Supabase's **leaked-password protection** (checks against the
HaveIBeenPwned breach database) if your plan supports it — defense in depth, not a
replacement for the policy above.

---

## 6. Route protection (the security boundary)

Every protected route must call a server-side guard before rendering or returning data:

```
function requireAuthorizedUser(request):
    user = supabaseServer.getUser()        # validates the session server-side
    if not user:
        redirect("/login")
    if not isEmailAllowed(user.email):
        redirect("/not-authorized")
    return user
```

**Important nuances:**
- Use the server client's **`getUser()`** (which validates the token with the auth
  server), not just reading the session from the cookie, for the authoritative check.
- **Middleware/proxy is NOT the security boundary.** Middleware is good for refreshing
  the session and doing a fast optimistic redirect, but the *real* authorization check
  must live in the route/server-component itself (`requireAuthorizedUser`). Treat
  middleware as UX, the per-route guard as security. (This mirrors current SSR-framework
  guidance.)
- Protect **API routes too**, not just pages — any endpoint that returns data needs the
  same guard.

---

## 7. Email: what needs it and what doesn't

A deliberate design choice to avoid a third-party email vendor for normal use:

| Flow | Sends email? |
|---|---|
| **Signup** | No — if "Confirm email" is OFF (see §8). Account is created and the user is logged in immediately. The allowlist already establishes the user is known/approved, so email confirmation is redundant. |
| **Login** | No — password is verified directly. |
| **Password reset** | **Yes** — this is the one flow that emails a link. Rare, so the built-in sender's low rate limit is acceptable. |

If you want reset to work without *any* email, you can omit self-service reset entirely
and have an admin reset passwords manually in the Supabase dashboard
(Authentication → Users). Then the app sends zero emails ever.

---

## 8. Supabase dashboard configuration

These are set in the Supabase project dashboard (not in code), under **Authentication**:

1. **Sign In / Providers → Email**: enabled.
2. **"Allow new users to sign up"**: ON (self-signup; the allowlist is what keeps it from
   being open).
3. **"Confirm email"**: **OFF** — so allowlist-gated signup logs the user in immediately
   with no confirmation email. (Leave ON only if you specifically want email-ownership
   verification on top of the allowlist, and have an email sender configured.)
4. **URL Configuration**:
   - **Site URL**: the app's base URL (e.g. `http://localhost:3000` for dev, the
     production URL when deployed).
   - **Redirect URLs**: add both the local dev URL and the production URL with a wildcard
     (e.g. `http://localhost:3000/**` and `https://yourapp.example/**`) — needed for the
     password-reset callback.
5. **Leaked-password protection** (optional): enable if available on your plan.

---

## 9. Keys & secrets (do not get this wrong)

- **Publishable / anon key** — safe in the browser. Used by the client Supabase instance
  for auth. Public by design.
- **Service-role key** — **server-only, never exposed to the browser, never prefixed as a
  public env var.** If your app reads privileged data server-side, it uses this key — but
  it must never reach client code.
- **Rotate any key that is ever exposed** (pasted in a chat, screenshot, commit). Keys
  live only in gitignored env files and the host's encrypted env store.
- **Lock down the database** independently of auth: by default, ensure the public Data API
  cannot read your tables with the browser key (deny-all RLS / revoked grants on sensitive
  tables). Authentication gates the *app*; database lockdown ensures the data isn't
  readable directly via the public API even with the publishable key. These are two
  separate protections and you want both.

---

## 10. User flows

**Signup**
1. User visits `/signup`, enters email + password.
2. Client validates password against the policy (live checklist).
3. On submit, **server** checks: is the email allowlisted? If not → reject, no account.
4. If allowlisted, server re-validates the password, then calls Supabase `signUp`.
5. With "Confirm email" OFF, a session is returned → user lands authenticated on the app.

**Login**
1. User visits `/login`, enters email + password.
2. Server calls Supabase `signInWithPassword`.
3. On success, server checks allowlist (defense in depth) → grants or sends to
   `/not-authorized`.
4. Session cookie set → protected routes now accessible.

**Logout**
1. User clicks sign out → server calls Supabase `signOut`, session cleared → redirect to
   `/login`.

**Password reset (optional)**
1. `/forgot-password` → user enters email → Supabase `resetPasswordForEmail` sends a link.
2. User clicks link → lands on `/update-password` (session established via the callback) →
   sets a new password (policy enforced) → done.

---

## 11. Acceptance criteria (test these)

- [ ] An **allowlisted** email can sign up and is logged in immediately (no email needed).
- [ ] A **non-allowlisted** email attempting signup is **rejected** and **no account is
      created** (verify in Authentication → Users that nothing was added).
- [ ] Login with correct credentials works; wrong password is rejected.
- [ ] **Every** protected route (pages AND API endpoints) redirects an unauthenticated
      visitor to `/login`.
- [ ] An authenticated user whose email is NOT on the allowlist is sent to
      `/not-authorized`, never the data.
- [ ] Password policy is enforced **server-side** (a request that bypasses the client
      still gets rejected for a weak password).
- [ ] Sign out clears the session.
- [ ] The service-role key never appears in any client bundle / browser-visible code.
- [ ] The database is not readable via the public API with the browser key (DB lockdown
      verified independently of auth).
- [ ] (If reset enabled) reset email link lands on the update-password page and a new
      password works on next login.

---

## 12. Supabase auth options (what the platform offers)

So you can see where the choices above sit within what Supabase supports. Supabase Auth
(its GoTrue service) offers, on **all plans including Free**:

- **Email + password** — the method this spec uses.
- **Magic link / OTP** — passwordless; emails a one-time sign-in link or code.
- **Social / OAuth** — Google, GitHub, Apple, etc.
- **Phone / SMS OTP** — (SMS sending needs a provider).
- **Anonymous sign-ins** — temporary users; note they count toward your active-user
  quota once they authenticate.
- **Custom SMTP** — route auth emails through your own provider (included free).
- **Basic multi-factor auth (MFA)**.

Auth features that are **NOT** on the Free plan (require a paid tier): leaked-password
protection (HaveIBeenPwned check), session timeouts, single-session-per-user controls,
SAML/SSO, and removing Supabase branding from auth emails.

**Why this spec chose email + password over magic link:** magic link is elegant
(nothing to remember) but it depends on **email delivery for every login** — which runs
straight into the free-plan email rate limit (next section). Email + password sends
**no email on normal login**, sidestepping that limit entirely. For a small, known set
of users that's the more robust free-plan choice. (If you prefer passwordless and are
willing to set up custom SMTP, magic link is perfectly viable — it's a trade, not a
right/wrong.)

---

## 13. Making it work on the Supabase Free plan (the decisions we walked through)

This spec was deliberately designed to run **fully free**. The decisions that make that
work — and the gotchas that forced them:

**The core gotcha: the built-in email sender allows only ~2 auth emails per hour.**
Supabase's default (built-in) email service is explicitly best-effort, non-production,
and rate-limited to roughly **2 messages/hour**. It applies to *every* email-sending auth
flow: signup confirmations, magic links, and password resets. Hit it during testing and
you get `429 email rate limit exceeded` — which looks like a broken app but is just the
free sender's cap. This single limit drove most of the decisions below.

**Decision 1 — Email + password, not magic link.** Because normal login with a password
sends no email, you never touch the 2/hour limit in day-to-day use. Magic link would have
emailed on every single login → unusable on the free sender without bringing in SMTP.

**Decision 2 — "Confirm email" OFF.** With it ON, every signup tries to send a
confirmation email → instantly hits the rate limit and the account gets stuck unconfirmed
(can't log in). Turning it OFF means signup creates the account and logs the user in with
no email. This is safe **because the allowlist already establishes the user is approved** —
email-ownership confirmation would be redundant on top of a pre-approved list. (If you
ever turn Confirm email back ON, you must configure custom SMTP or signups will fail.)

**Decision 3 — Password reset is the one accepted email flow.** Resets are rare (a person
won't reset more than once or twice in an hour), so the 2/hour cap is fine for them. Result:
**login and signup send zero emails; only reset sends one** — so the whole app runs on the
free built-in sender without ever configuring an external provider. (If you want truly
zero email, drop self-service reset and have an admin reset passwords in the dashboard.)

**Decision 4 — No paid-only features in the critical path.** Leaked-password protection is
Pro-only, so it's treated as optional/nice-to-have, not relied upon — the 4-rule password
policy (enforced in your own code) does the real work and is plan-independent.

**Other Free-plan facts worth designing around:**

- **50,000 monthly active users (MAU)** on Free — generous; only users who *authenticate*
  in a given month count (stored-but-inactive users don't). Most small apps never approach
  this.
- **Free projects pause after ~7 days of inactivity** (you restore them from the dashboard
  in a click). Fine for internal/low-traffic tools; if the app must never sleep, that alone
  is the reason to go Pro (~$25/mo), not anything about auth.
- **2 active projects** max on Free; **500 MB** database; **no backups / no SLA**.
- **API auth endpoints** have their own IP-based rate limits (token-bucket, ~30 burst) —
  separate from the email limit, rarely hit by normal use, and configurable under
  Authentication → Rate Limits.

**If/when you outgrow the free email cap** (e.g. you switch to open public signup with
email confirmation, or you want branded emails from your own domain): configure **custom
SMTP** — it's included free on Supabase, and providers like Resend / SendGrid / Mailgun /
Mailtrap have free tiers far beyond a small app's needs. With custom SMTP the auth-email
limit rises to a default of **~30 new users/hour** (and is governed by your provider, not
Supabase's 2/hour cap). This is the single upgrade that unlocks magic link, email
confirmation, and high-volume signup — all still free.

**Net:** this design (email+password · Confirm-email OFF · allowlist · reset-only email ·
no paid-only features) runs a real, secure, multi-user app on the **$0 Supabase plan** with
no external email vendor. The only reasons you'd pay: you need the project to never sleep,
guaranteed backups, more than 2 projects, or you cross into open/high-volume signup that
wants custom SMTP (still cheap/free).

---

## Variant: open (non-allowlisted) signup

If the product genuinely needs **public** registration (anyone can create an account):

- Remove the allowlist gate at signup; **keep** a post-login authorization concept if some
  users should have elevated access (roles).
- You almost certainly want **"Confirm email" ON** (verify address ownership), which means
  you DO need a working email sender — configure **custom SMTP** (a provider's free tier is
  typically sufficient) so you're not limited by the built-in sender's low rate cap.
- Strongly consider **per-user Row-Level Security** so each user only sees their own data —
  with open signup you can no longer assume every authenticated user is trusted with
  everything.
- Keep the password policy and the server-side enforcement exactly as above.

The rest of the spec (keys, route guards, SSR session handling, password policy) is
unchanged.
