-- 0014: stable-identity resolution (deterministic-id hardening).
--
-- The persisted alias -> stable-canonical-id map. Identity stops being a UUIDv5 of
-- the mutable label. Instead the miner resolves an extracted entity to an existing
-- stable id through this map (plus the current canonical rows, the corrections, and
-- a conservative fuzzy match), minting a new RANDOM id only on no match. A label
-- DRIFT records a new alias here; it does NOT change the id, so companion_state and
-- the freshness state (last_confirmed_at, salience, superseded_by), which key on the
-- canonical id, survive the drift.
--
-- This is SCHEMA ONLY. It is safe to apply: it adds a table and writes nothing to
-- the canonical layer. Populating it from the existing graph (the data step) is a
-- separate, operator-applied migration (scripts/migrate-identity.mjs), held back per
-- the hardening PR. The miner also self-seeds it at resolve time, so the table being
-- empty is correct (an existing entity still resolves by its current label).
--
-- Miner-owned operational state: the client may SELECT its own rows; writes come
-- ONLY from the service-role miner path (no client write policy), mirroring
-- miner_state and the canonical read-only bucket (invariant 4).

create table if not exists public.entity_aliases (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  entity_table  text not null,                 -- 'canonical_people' | ... | 'insights'
  alias_norm    text not null,                 -- normalized label / alias (the resolution key)
  stable_id     uuid not null,                 -- the canonical id this alias resolves to
  source        text not null default 'miner', -- 'miner' | 'seed' | 'correction'
  created_at    timestamptz not null default now()
);

-- One stable id per (user, table, alias): the resolution key is unambiguous.
create unique index if not exists entity_aliases_key
  on public.entity_aliases (user_id, entity_table, alias_norm);
create index if not exists entity_aliases_stable_idx
  on public.entity_aliases (user_id, entity_table, stable_id);

alter table public.entity_aliases enable row level security;
alter table public.entity_aliases force row level security;
create policy entity_aliases_sel on public.entity_aliases
  for select to authenticated using (user_id = auth.uid());

-- Service-role only writes (the miner is the sole writer of identity state).
revoke insert, update, delete on public.entity_aliases from authenticated, anon;
