-- 0019: user-owned work/personal tag on events.
--
-- People already carry a work_or_personal class (miner-derived, inside canonical
-- data). This gives EVENTS the same tag, but as a USER-set overlay, not a canonical
-- edit: canonical is the miner's alone (invariant 4), so the tag is classified by
-- the user and stored here, read alongside canonical and never written into it. Same
-- mutable-overlay + classification pattern as companion_state (the commitment
-- overlay). Keyed on the canonical event id; a label drift on a re-mine could orphan
-- a tag (the documented deterministic-id limitation, mitigated system-wide by the
-- stable-identity resolver), which only means a tag would need re-setting, never a
-- data-safety issue.
create table public.event_tags (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  event_id         uuid not null,                    -- canonical_events.id
  work_or_personal text not null,                    -- 'work' | 'personal'
  updated_at       timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (user_id, event_id)
);
create index event_tags_user_idx on public.event_tags (user_id);

-- Mutable, user-written overlay: FORCE RLS + full per-user policies (the user sets
-- the tag from the app via their RLS client, like companion_state).
alter table public.event_tags enable row level security;
alter table public.event_tags force row level security;
create policy event_tags_sel on public.event_tags
  for select to authenticated using (user_id = auth.uid());
create policy event_tags_ins on public.event_tags
  for insert to authenticated with check (user_id = auth.uid());
create policy event_tags_upd on public.event_tags
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy event_tags_del on public.event_tags
  for delete to authenticated using (user_id = auth.uid());
