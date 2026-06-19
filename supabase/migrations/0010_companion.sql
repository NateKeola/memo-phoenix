-- PR7 / 0010: companion core. Operational state for the today surface, the
-- server-only Google connection, and an append-only audit of high-stakes actions.

-- Commitment state overlay (done / snooze / dismiss). This is MUTABLE operational
-- UI state kept OUT of canonical so the miner never rebuilds or churns it: the
-- today surface reads it ALONGSIDE canonical_commitments and the overlay wins.
-- Keyed on the canonical commitment id (deterministic, so it survives recompute as
-- long as the commitment label is stable). Like interview_sessions it carries no
-- append-only / history trigger, because a user toggles the state.
create table public.companion_state (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  commitment_id uuid not null,                       -- canonical_commitments.id
  state         text not null default 'open',        -- 'open' | 'done' | 'snoozed' | 'dismissed'
  snooze_until  timestamptz,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (user_id, commitment_id)
);
create index companion_state_user_idx on public.companion_state (user_id);

alter table public.companion_state enable row level security;
alter table public.companion_state force row level security;
create policy companion_state_sel on public.companion_state
  for select to authenticated using (user_id = auth.uid());
create policy companion_state_ins on public.companion_state
  for insert to authenticated with check (user_id = auth.uid());
create policy companion_state_upd on public.companion_state
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy companion_state_del on public.companion_state
  for delete to authenticated using (user_id = auth.uid());

-- Server-only Google OAuth tokens. FORCE RLS with NO policies, so authenticated
-- and anon roles can never read or write it: ONLY the service-role client (server
-- side) touches this table. The tokens never reach the browser. One row per user.
create table public.google_connections (
  user_id       uuid primary key,
  email         text,
  access_token  text,
  refresh_token text,
  scope         text,
  expiry        timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.google_connections enable row level security;
alter table public.google_connections force row level security;
-- intentionally no policies: service_role bypasses RLS; everyone else is denied.

-- Append-only audit of high-stakes actions the companion takes on the user's
-- behalf (a drafted email/invite that was sent or created). Provenance for any
-- external side effect. Written server-side (service-role) by the send routes; the
-- user can read their own history.
create table public.companion_actions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  kind          text not null,                       -- 'email' | 'calendar'
  status        text not null,                       -- 'sent' | 'created' | 'failed'
  commitment_id uuid,
  target        text,                                -- recipient email / attendee
  payload       jsonb not null default '{}'::jsonb,  -- subject/body or title/time (no secrets)
  created_at    timestamptz not null default now()
);
create index companion_actions_user_idx on public.companion_actions (user_id, created_at desc);

alter table public.companion_actions enable row level security;
alter table public.companion_actions force row level security;
create policy companion_actions_sel on public.companion_actions
  for select to authenticated using (user_id = auth.uid());
-- inserts are server-side via the service-role client; no authenticated insert.
create trigger companion_actions_append_only
  before update or delete on public.companion_actions
  for each row execute function public.forbid_mutation();
