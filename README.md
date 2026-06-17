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

Migrations live in `supabase/migrations/` and are forward-only (never edit a migration after it has been applied). They reach the dev project two ways:

- During bootstrap (PR0 and PR1): directly, with `supabase db push` against the linked dev project.
- After that: automatically by [.github/workflows/migrate.yml](.github/workflows/migrate.yml) on merge to `main` (paths `supabase/migrations/**`). `supabase db push` is idempotent, so re-runs are safe.

The schema is the load-bearing spine. Every append-only table (`captures`, `corrections`, `confirmations`, all `raw_*`, `canonical_history`, `telemetry_events`) is enforced by a `forbid_mutation()` trigger. Every canonical row carries the mandatory shared block (provenance `source_claim_ids`, temporal class, validity interval, confidence, salience, `last_confirmed_at`). RLS is enabled and FORCED on every table, scoped to `user_id = auth.uid()`.

## Merge-driven model

The only privileged action from the build environment is `gh` PR create and merge. Platform tokens live in GitHub Actions secrets, not in the local environment.

Set these as GitHub Actions secrets BEFORE merging PR0 (otherwise the first `migrate.yml` run fails with a harmless red X, since the dev DB is already migrated during bootstrap):

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_DB_PASSWORD`
- `SUPABASE_PROJECT_REF` (`azlobwtiptvarfeukzcv`)

Set the Vercel project environment variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) in the Vercel dashboard.

## Single-user lock

This is not a public app. The real control is on the remote Supabase project: disable signups (dashboard or Management API) after the single user account is created. The app ships only a `/login` page (no signup UI), and FORCE RLS means any other account would see zero rows. Create the account first, then disable signups.
