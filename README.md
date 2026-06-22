# memo-pheonix

This is the all encompassed memo, follow up, interview, context builder for a human.

Single-user personal knowledge and companion system. Capture (voice memo, text, interview) feeds a miner that builds a personal knowledge graph, which a companion layer reads. The source of truth for scope and architecture is [docs/memo-phoenix-spec.md](docs/memo-phoenix-spec.md). Build follows the spec section 16 PR sequence.

## Stack

- Next.js App Router (single app) plus a `packages/miner-core` workspace package (engine ported in PR1).
- Supabase: Postgres, Auth, RLS, the data spine.
- Direct Anthropic SDK for the miner and companion (no LangChain). Wired in later PRs.
- Vercel for deploys via the Git integration.

## Local setup

Requires Node 22 (see `.nvmrc`) and npm.

```bash
npm install
cp .env.example .env.local   # then fill in real values
npm run dev                  # http://localhost:3000
```

Other scripts: `npm run build`, `npm run typecheck`, `npm run lint`, `npm run db:push`.

### Environment

See [.env.example](.env.example). The service-role key is server-only and must never carry the `NEXT_PUBLIC_` prefix. It is read only by `lib/supabase/admin.ts`, which begins with `import 'server-only'` so a client-side import is a build error.

## Database and migrations

Migrations live in `supabase/migrations/` and are forward-only (never edit a migration after it has been applied, and never apply an empty one). See [docs/MIGRATIONS.md](docs/MIGRATIONS.md) for the full runbook: the required-secrets checklist, the CLI-independent fallback, and the guard. They reach the dev project three ways:

- **On merge to main (the normal path):** [.github/workflows/migrate.yml](.github/workflows/migrate.yml) runs `supabase db push` on every merge that touches `supabase/migrations/**`, then verifies the remote actually has every migration. This needs the three GitHub Actions secrets below.
- **CLI-independent fallback:** `npm run db:status` reports applied vs pending against the remote, and `npm run db:apply` applies anything pending. It goes through the Supabase Management API over HTTPS (no Supabase CLI, no database password, no `pg` driver), so it works when the CLI cannot connect from a machine. It needs `SUPABASE_PROJECT_REF` and `SUPABASE_ACCESS_TOKEN` in the environment or `.env.local`.
- **Bootstrap (PR0 and PR1):** directly, with `supabase db push` against the linked dev project.

Check the live applied-vs-pending state any time with `npm run db:status`.

The schema is the load-bearing spine. Every append-only table (`captures`, `corrections`, `confirmations`, all `raw_*`, `canonical_history`, `telemetry_events`) is enforced by a `forbid_mutation()` trigger. Every canonical row carries the mandatory shared block (provenance `source_claim_ids`, temporal class, validity interval, confidence, salience, `last_confirmed_at`). RLS is enabled and FORCED on every table, scoped to `user_id = auth.uid()`.

## Merge-driven model

The only privileged action from the build environment is `gh` PR create and merge. Platform tokens live in GitHub Actions secrets, not in the local environment.

Set these three under **Settings -> Secrets and variables -> Actions -> New repository secret**. This is the gap that made `migrate.yml` fail on earlier PRs: the secrets were never set, so every run errored and migrations had to be applied by hand (and the remote could lag local). [docs/MIGRATIONS.md](docs/MIGRATIONS.md) says exactly where each value comes from:

- `SUPABASE_ACCESS_TOKEN` (Supabase account -> Access Tokens; also used by `npm run db:apply`)
- `SUPABASE_DB_PASSWORD` (Project Settings -> Database)
- `SUPABASE_PROJECT_REF` (`azlobwtiptvarfeukzcv`)

Set the Vercel project environment variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) in the Vercel dashboard.

## Auth: email + password + allowlist (no auth email)

Access is invite-only. Auth is **email + password**, gated by the invite allowlist. NO email is sent on signup or login (the magic-link / OTP flow was removed because Supabase's built-in sender is rate-limited and unreliable, which broke logins).

Operator path to add a person:

1. Sign in as the operator, go to `/admin`, and add the person's **email** to the allowlist. That is the whole invite: no account is created, no link to copy, no email sent.
2. The person goes to `/login`, opens **Create account**, enters that same email and chooses a password (live policy checklist: 8+ chars, a letter, a number, a special character). They are logged in immediately and dropped into the onboarding interview.

A non-allowlisted email is clearly rejected at signup and no account is created. **Revoke** in `/admin` removes the email from the allowlist; because the route guard re-checks the allowlist on every request, a revoked user is locked out on their next request.

### Required Supabase operator settings (no SMTP needed)

- Authentication -> Providers -> **Email**: **Email provider enabled**, **Confirm email OFF**. (Accounts are minted via the service-role admin API with the address pre-confirmed, so no verification email is ever sent; Confirm-email OFF is belt-and-suspenders.)
- Authentication -> Providers: **public signups stay DISABLED** (`disable_signup: true`). The only way to mint an account is the service-role admin path, which is gated by the allowlist, so there is no public registration surface and no GoTrue bypass.
- No custom SMTP is required for the beta. There are no auth emails.

### No self-service password reset (beta posture)

There is deliberately no self-service reset, to keep auth email at zero. If someone needs a reset, the operator sets a new password for them in the Supabase dashboard (Authentication -> Users). The spec's email-based reset flow can be added later if that tradeoff changes.

OAuth / SSO is deferred (a muted "coming later" note on `/login`).

## Public signups stay disabled

This is not a public app. The control is on the remote Supabase project: signups are disabled (`disable_signup: true`, dashboard or Management API). The only public route is `/login` (Sign in plus an allowlist-gated Create account, never open self-signup), accounts are created only through the service-role admin path after the allowlist check, and FORCE RLS means any account would see only its own rows. Add beta users via the `/admin` invite path; do not re-enable signups.

## Interview agent (PR3)

The "Start interview" path opens a voice conversation with Memo in two modes that share one system prompt (the bible at `packages/miner-core/prompts/memo-companion-bible.md`, bundled to `lib/interview/bible.generated.ts` via `npm run bible:generate`):

- **Open brain-dump** — bible only, blank slate, available any time.
- **Daily check-in** — a deterministic briefing (`lib/interview/briefing.ts`) reads your canonical graph and composes a short brief (recent threads, open follow-ups, plus a couple of stubbed resurfacing items), injected alongside the bible.

The conversation runs on ElevenLabs Conversational AI. The signed URL is minted server-side (`/api/interview/start`), so `ELEVENLABS_API_KEY` never reaches the browser; the per-session system prompt + first message are applied client-side via `conversation_config_override`. On end (`/api/interview/end`), the authoritative transcript is fetched from ElevenLabs and written as one `mode='interview'` capture, which the miner folds into the graph on its next run.

### Required one-time ElevenLabs dashboard step

`conversation_config_override` only works if the agent permits overrides. Overrides are disabled by default, and an override sent for a non-enabled field throws an error (the conversation fails to start), so this is not optional:

1. Open your agent in the ElevenLabs dashboard.
2. Go to the agent's **Security** tab.
3. Enable the override toggles for **System prompt** and **First message**.

Set `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` to that agent's id and `MEMO_USER_NAME` to your name (used in the bible).

## Companion: conversational follow-ups (`/companion`)

The "Follow-ups" surface reads your open commitments and the people who matter to you from the graph with deterministic queries (no model call), and nudges you, in plain language, to stay connected:

- **Commitment follow-ups** grouped overdue / soon / open, each phrased as a suggestion to act ("you said you'd go spearfishing with Kolton, in a couple weeks"), with provenance.
- **Relationship nudges**: close people you have not brought up much, from a simple transparent recency heuristic (closeness weight, then least-recently-mentioned, then fewest mentions). The real decay-and-salience scoring is the freshness loop, a later PR.

From any nudge you can open a short **brainstorm** with Memo to think it through ("what should I get my mom"). Memo has your graph via the retrieval tools and suggests small real-life next steps and text you can copy. It does not send anything: suggestions point you to act in your own life.

Mark a follow-up done, snooze it, or dismiss it; that state lives in `companion_state` (a mutable overlay), never in canonical, so it survives a miner run. The overlay is label-drift resilient: it stores a stable signature (label plus person) and re-matches a commitment that re-resolved under a new id, so your done/snooze state is not lost when a label drifts.

Sending email or creating calendar events (with Google OAuth and single sign-on) is deferred to a later settings/connectors build.
