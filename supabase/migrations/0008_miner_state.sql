-- PR1 / 0008: miner processing state.
--
-- The miner memoizes input hashes per scope so a second run over unchanged input
-- does no LLM work and writes nothing (keeping canonical_history free of
-- recompute churn). This is mutable state, NOT append-only and NOT canonical, so
-- it carries no forbid_mutation / history triggers. Per the PR1 forward note,
-- "already processed" state lives in a SEPARATE table, never as a column on the
-- append-only captures table.
--
-- scope examples: 'extract:<capture_id>', 'derive:canonical_people'.

create table public.miner_state (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  scope      text not null,
  input_hash text not null,
  updated_at timestamptz not null default now(),
  unique (user_id, scope)
);
create index miner_state_user_idx on public.miner_state (user_id);

-- RLS: FORCED, scoped to the user. Writes are service-role only (the miner);
-- authenticated may read its own state.
alter table public.miner_state enable row level security;
alter table public.miner_state force row level security;
create policy miner_state_sel on public.miner_state
  for select to authenticated using (user_id = auth.uid());
