# Security report: multi-user boundary (B1 gate)

This is the certifying artifact for the row-level-security boundary. It records the
state proven before any second real user's data enters the database. Re-run the two
committed checks any time the schema or auth config changes:

```
node scripts/check-rls.mjs         # RLS state from the live DB (60 assertions)
node scripts/check-multiuser.mjs   # two real users, behavioral isolation (app/RLS paths)
node scripts/check-miner-isolation.ts  # two users, the service-role MINER path (tsx)
```

Verified against the dev project `azlobwtiptvarfeukzcv` on 2026-06-19. Result: the
data boundary holds under real two-user conditions. One access-control gap was
found (public signups were enabled) and fixed (disabled).

## 1. Every table and its RLS state

All enumeration is from the LIVE database (pg_catalog via the Management API), not
from the migration files. There are 28 tables and 1 view in the public schema.

**Every table has RLS ENABLED and FORCED** (forced means even the table-owner role
is subject to policy). Tables added after the original PR0 audit
(`companion_state`, `interview_sessions`, `miner_state`, `discrepancies`,
`open_threads`, and the `captures.target_kind` / `target_id` columns) all carry
FORCE RLS. No table is missing it.

**Every table has per-user policies scoping to `user_id = auth.uid()`.** No policy
is permissive across users (no `using (true)`, none granted to `public`/`anon`).
All policies are on the `authenticated` role. The buckets:

- Read-only canonical bucket (SELECT only, no client write): `canonical_people`,
  `canonical_places_orgs`, `canonical_projects`, `canonical_events`,
  `canonical_facts`, `canonical_relationships`, `canonical_commitments`, `insights`,
  `canonical_history`, `discrepancies`, `open_threads`, `miner_state`,
  `telemetry_events`. This enforces invariant 4 (canonical is never edited by the
  client) at the database layer: a signed-in user cannot INSERT/UPDATE/DELETE these.
- Append-only input bucket (SELECT + INSERT, no update/delete): `captures`,
  `corrections`, `confirmations`, `collections`, `collection_items`, and the 8
  `raw_*` tables. INSERT carries a `with check (user_id = auth.uid())`, so a user
  cannot insert a row stamped as another user.
- Mutable operational bucket: `companion_state` (SELECT/INSERT/UPDATE/DELETE),
  `interview_sessions` (SELECT/INSERT/UPDATE). UPDATE policies carry both a USING
  and a WITH CHECK on `user_id = auth.uid()`.

**The one view, `reconfirm_candidates`, is `security_invoker = on`.** It therefore
runs with the querying user's privileges and inherits the underlying canonical
tables' RLS, rather than the view owner's. It does not bypass RLS. This was proven
behaviorally (a signed-in user sees only their own decaying rows through the view).
Note for future changes: this view's safety depends on `security_invoker` staying
on. If the view is ever recreated, it must keep `with (security_invoker = on)`.

**SECURITY DEFINER functions:** only `snapshot_canonical()` (the canonical-history
trigger) is SECURITY DEFINER. It is a row-local AFTER trigger that stamps the
changed row's own `user_id` into history; it is not callable via PostgREST RPC and
does not read across users. `forbid_mutation()` is SECURITY INVOKER.

**Role attributes:** the client-facing roles `anon` and `authenticated` both have
`bypassrls = false`, so they cannot escape RLS. Only `service_role` and `postgres`
have `bypassrls = true`; neither is a client role (clients connect through
`authenticator`, which also has `bypassrls = false`, and switch to `anon` /
`authenticated` based on their JWT).

No RLS gap was found, so no RLS migration was required.

## 2. Service-role isolation

The service-role key bypasses RLS by design (the miner needs it), so it must never
reach the browser and every server path that uses it must scope by user in code.

- `lib/supabase/admin.ts` (the service-role client factory) begins with
  `import 'server-only'`, which makes any client-side import a build error. The app
  builds successfully (Vercel), so the key cannot be in the client bundle.
- The service-role key value appears in NO tracked source file and nowhere in the
  repo outside the gitignored `.env.local` (grep of the key value returns 0).
- There is no `NEXT_PUBLIC_` prefix on the service-role key anywhere.
- The browser client (`lib/supabase/client.ts`) uses the anon key only.
- An anonymous (unauthenticated) client sees zero rows in every table, because the
  policies apply to `authenticated` only and there is no policy for `anon` (default
  deny). Proven for `captures`, `canonical_people`, `canonical_facts`,
  `companion_state`, `reconfirm_candidates`, and `telemetry_events`.

## 3. Service-role server paths scope by user

Every service-role caller was audited. The app's only service-role usage is
`lib/telemetry.ts` (server-only), which INSERTs telemetry stamping `user_id`
explicitly (no read path, so no cross-user read).

The miner (`packages/miner-core`) is the main service-role consumer. It runs as
`mine(userId)` for ONE user and:

- reads captures with `.eq('user_id', userId)` (`run.ts`), so it never feeds one
  user's captures into another's pipeline;
- `extract.ts` stamps `user_id: capture.user_id` and `capture_id` onto every raw
  row, derives the raw id from the user id, and resolves a capture's target only
  within that capture's own user (`.eq('user_id', userId)`);
- every read/write in `stage-common.ts`, `derive.ts`, `corrections.ts`, and
  `freshness.ts` (reconcile + supersede) carries `.eq('user_id', userId)` and every
  written row carries `user_id: userId`;
- `seed.ts` (dev tool) scopes to the configured `MEMO_USER_ID`.

There is no service-role path that operates across users.

**Re-audited and guarded (miner-isolation hardening, 2026-06-20).** The miner is
the main RLS-bypassing path, so it now has a dedicated, re-runnable guard
(`scripts/check-miner-isolation.ts`) in addition to the code audit. Every `.from(`
query in `packages/miner-core/src` was re-enumerated and confirmed to carry an
explicit `user_id` filter, including the new PR #17 resolver: `resolve-store.ts`
`buildResolver` (`.eq('user_id', userId)`) and `readAliasMap`
(`.eq('user_id', userId).eq('entity_table', table)`) self-seed from and resolve
against ONLY the target user's rows, so an alias can never match another user's.
The canonical id is globally unique per user by construction (the user id is hashed
into `canonicalId`/`canonicalPersonId`, and new entities mint `randomUUID()`), so the
`onConflict:'id'` upsert can never cross users. Two defense-in-depth fixes landed:
the `miner_runs` updates in `mineWithLock` now also filter `.eq('user_id', userId)`,
and `mine()`/`mineWithLock()` call a hard `assertUserId` (uuid-format) guard so a
missing or malformed user_id THROWS rather than running unscoped. The trigger paths
are single-user only: `/api/miner/run` (one target user), the cron sweep (per-user
Action dispatch), and `miner.yml` (a required, preflight-validated `user_id`). There
is no global/all-users mine path. The guard creates two users, seeds distinct data
(including a shared label and an identical alias for both), and proves two-way
isolation across captures, raw, canonical, aliases, miner_state, and miner_runs, plus
that the real resolver cannot resolve to the other user's id/alias and that the miner
hard-fails without a valid user_id. Result: **33 assertions passed, 0 failed.**

## 4. Two-user behavioral test

`scripts/check-multiuser.mjs` creates two real, clearly-marked test users, populates
each with distinct deletable data (canonical people, commitments, a decaying fact),
signs them in, and asserts isolation. Result: **30 assertions passed, 0 failed.**
Proven:

- each user sees only their own canonical_people / canonical_commitments /
  canonical_facts; neither sees the other's;
- a direct lookup of the other user's row by id returns 0 rows;
- a user cannot INSERT a capture stamped as the other (RLS WITH CHECK denies it);
- a user cannot UPDATE the other's companion_state (0 rows affected);
- the `reconfirm_candidates` view returns only the querying user's rows;
- an anonymous client sees 0 rows everywhere;
- a signed-in user cannot read the pre-existing real user's captures.

The test inserts only into mutable tables and deletes everything (including the two
auth users) on teardown, so it leaves no residue. Verified after the run: zero rows
in any table are owned by anyone other than the single real user.

## 5. Signup state

`scripts/check-rls.mjs` and the audit found that public email signups were ENABLED
(`disable_signup: false`) on the dev project, contrary to the intended closed
posture. The data boundary was not at risk (RLS isolates any account, proven above),
but anyone could create an account. This gap was FIXED in this pass: signups are now
DISABLED (`disable_signup: true`, set via the Management API). Email login still
works for the existing user; only new self-service signups are blocked.

Current state: signups DISABLED, 1 user (`natekeola@icloud.com`).

### What B2 must change to allow invite-only access (NOT done here)

- Supabase Auth: keep `disable_signup: true`. Create each beta user with the admin
  API (`POST /auth/v1/admin/users`, `email_confirm: true`) or send an invite
  (`POST /auth/v1/invite`); do not flip `disable_signup` back to false (that would
  reopen public signups).
- App: the only public route is `/login` (no signup UI) and that stays. Onboarding
  (the intro interview, first-run prompt) is the app-side B2 work.
- The per-user RLS boundary certified here is unchanged by adding users; this report
  is the evidence it is safe to add the second.

## 6. Findings and fixes

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | All 28 tables have FORCE RLS + correct per-user policies | n/a | Verified, no change |
| 2 | `reconfirm_candidates` view is security_invoker (no leak) | n/a | Verified, no change |
| 3 | Service-role key absent from client bundle / source | n/a | Verified, no change |
| 4 | All service-role server paths (miner incl.) scope by user | n/a | Verified, no change |
| 5 | Two-user isolation holds through every path | n/a | Proven (30/30) |
| 6 | Public signups were ENABLED, should be closed | High (posture) | FIXED (disabled) |

The data-isolation gate passes. The one access-control gap (open signups) is closed.

## 7. Service-role miner path (2026-06-20 hardening)

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 7 | Every miner-pipeline query (incl. the PR #17 resolver) is explicitly user-scoped | n/a | Verified by enumeration |
| 8 | `miner_runs` updates targeted by id only (no user_id filter) | Low (defense in depth) | FIXED (added `.eq('user_id', userId)`) |
| 9 | `mine()` / `mineWithLock()` did not hard-fail on a missing/invalid user_id | Low (no leak, but no guard) | FIXED (`assertUserId` throws; no unscoped run) |
| 10 | Trigger paths are single-user only; no global-mine path exists | n/a | Verified (route, cron per-user, Action required user_id) |
| 11 | Dedicated two-way miner isolation guard | n/a | Added (`check-miner-isolation.ts`, 33/33) |

The service-role miner path is now audited and guarded for per-user isolation.
