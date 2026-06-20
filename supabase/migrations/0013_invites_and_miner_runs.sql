-- B2 / 0013: invite-only beta enablement.
--
-- Two new tables. Both follow the standing pattern: a user_id tenant key, FORCE
-- RLS, per-user policies scoped to user_id = auth.uid(). They are auto-covered by
-- scripts/check-rls.mjs (which enumerates the live schema), so a wrong policy
-- fails the guard. Written idempotently (if not exists) so a re-run is safe.

-- ---------------------------------------------------------------------------
-- invites: the operator's record of who they invited. Mutable operational state
-- (a status that moves pending -> accepted / revoked), so NO append-only trigger.
--
-- user_id is the INVITER (the operator), not the invitee, so the row is owned by
-- and visible to the operator under the standard user_id = auth.uid() policy. The
-- invitee's address is a data column; the invited account is created out-of-band
-- by the service-role admin API (generateLink), and "only invited addresses get
-- an account" is enforced structurally: public signups stay disabled, so the only
-- way to mint an account is this admin path. The service role reads invites by
-- email at accept time (bypassing RLS); the invitee never reads this table.
create table if not exists public.invites (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,                       -- the operator who created the invite
  email           text not null,                       -- invitee address (stored lowercased by the app)
  status          text not null default 'pending',     -- 'pending' | 'accepted' | 'revoked'
  invited_user_id uuid,                                 -- auth.users id of the created invitee (filled at invite time)
  note            text,
  created_at      timestamptz not null default now(),
  accepted_at     timestamptz
);
-- One live invite per address (a revoked row is replaced on re-invite by the app).
create unique index if not exists invites_email_uniq on public.invites (lower(email));
create index if not exists invites_user_idx on public.invites (user_id, created_at desc);

alter table public.invites enable row level security;
alter table public.invites force row level security;
create policy invites_sel on public.invites
  for select to authenticated using (user_id = auth.uid());
create policy invites_ins on public.invites
  for insert to authenticated with check (user_id = auth.uid());
create policy invites_upd on public.invites
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy invites_del on public.invites
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- miner_runs: one row per miner invocation. Serves three jobs at once:
--   1. the concurrency LOCK (one active run per user, enforced by the partial
--      unique index below, so two triggers cannot mine the same graph at once);
--   2. an audit trail of when/why/where each mine ran;
--   3. the "building your memory" status the new-user UI polls.
--
-- Mutable operational state. The user may SELECT their own runs (to poll status);
-- writes come ONLY from the service-role miner path (no client INSERT/UPDATE
-- policy, mirroring the read-only canonical bucket), so this is invariant 4 at the
-- DB layer for the run ledger too.
create table if not exists public.miner_runs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  status      text not null default 'running',         -- 'running' | 'done' | 'error'
  trigger     text not null default 'manual',          -- 'onboarding' | 'manual' | 'cli' | 'action'
  runtime     text,                                     -- 'vercel' | 'github' | 'local'
  summary     jsonb,                                    -- MineSummary on completion
  error       text,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);
-- The lock: at most one run with status='running' per user. A second concurrent
-- insert hits this unique index (SQLSTATE 23505), which the trigger code reads as
-- "already running" rather than starting a colliding mine.
create unique index if not exists miner_runs_one_active
  on public.miner_runs (user_id) where status = 'running';
create index if not exists miner_runs_user_idx on public.miner_runs (user_id, started_at desc);

alter table public.miner_runs enable row level security;
alter table public.miner_runs force row level security;
create policy miner_runs_sel on public.miner_runs
  for select to authenticated using (user_id = auth.uid());

-- Secondary append-only-ish layer: the client roles get no write grant on
-- miner_runs (writes are service-role only).
revoke insert, update, delete on public.miner_runs from authenticated, anon;
