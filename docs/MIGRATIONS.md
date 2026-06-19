# Database migrations

Schema changes are forward-only SQL files in `supabase/migrations/` (for example
`0012_capture_target_and_followup.sql`). Never edit the database schema by hand in
the dashboard, and never apply an empty migration.

There are two ways to apply them. The GitHub Action is the normal path; the
`npm run db:apply` fallback is for when the Supabase CLI cannot connect.

## How applied vs pending is tracked

Applied migrations are recorded in `supabase_migrations.schema_migrations` on the
remote (the same table the Supabase CLI uses). The version is the filename prefix
before the first underscore (`0012`). Both `supabase db push` and `npm run db:apply`
read and write this table, so they agree on what is applied.

Check the live state any time:

```
npm run db:status
```

It prints each migration as APPLIED or PENDING and a summary, against the remote.

## Path 1: on merge to main (the GitHub Action)

`.github/workflows/migrate.yml` runs on every push to `main` that touches
`supabase/migrations/**`. It links the dev project, runs `supabase db push`, then
runs `npm run db:status --check` to confirm the push actually applied everything
(so a silent no-op cannot ship code against a database missing its migration).

### Required GitHub Actions secrets (set these or every run fails)

This is the gap that made migrate fail on earlier PRs: the secrets were never set.
Set all three under **Settings -> Secrets and variables -> Actions -> New
repository secret**:

- [ ] `SUPABASE_ACCESS_TOKEN` - a Supabase personal access token. Create at
      https://supabase.com/dashboard/account/tokens (Account -> Access Tokens ->
      Generate new token). Used by both the CLI and the `db:status`/`db:apply`
      fallback.
- [ ] `SUPABASE_DB_PASSWORD` - the dev database password. Supabase dashboard ->
      Project Settings -> Database -> Database password (reset it there if unknown).
- [ ] `SUPABASE_PROJECT_REF` - `azlobwtiptvarfeukzcv` (the dev project ref).

The workflow's first step now fails loudly and names any missing secret, instead
of a cryptic CLI error.

## Path 2: CLI-independent fallback (`npm run db:apply`)

`scripts/db.mjs` applies migrations through the Supabase Management API over HTTPS.
It does NOT use the Supabase CLI, needs NO database password, and needs NO `pg`
driver, so it works when the CLI cannot connect from a machine.

It reads two values from the environment (or `.env.local`):

- `SUPABASE_PROJECT_REF` (`azlobwtiptvarfeukzcv`)
- `SUPABASE_ACCESS_TOKEN` (the same access token as above)

Then:

```
npm run db:status     # report applied vs pending, unambiguously
npm run db:apply      # apply every pending migration in order, recording each
```

`db:apply` runs each pending migration's SQL and records its version in
`schema_migrations`. Migrations are written idempotently (`if not exists` /
`add column if not exists` / `drop table if exists`), so a retry after a partial
failure is safe.

For local use, add `SUPABASE_ACCESS_TOKEN=...` to `.env.local`.

## The guard

`npm run db:status --check` exits non-zero and names any migration that is not
applied on the remote. The migrate workflow runs it after `db push`, so a failed
or no-op push becomes a visible red X naming the missing migration, rather than
silently shipping code against a stale database.

## Last verified

See the dated entry in the CLAUDE.md decision log for the most recent verified
applied-vs-pending state of the dev project.
