-- PR0 / 0002: append-only ground-truth input layer (spec 4.2, invariant 1).
-- captures, corrections, confirmations. corrections and confirmations stay
-- separate (open decision #8, lean: separate; read identically by the miner).

create table public.captures (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  mode         text not null,          -- 'memo' | 'text' | 'interview'
  modality     text not null,          -- 'voice' | 'text'
  body         text,                   -- typed text or STT transcript
  audio_url    text,                   -- memo / interview audio if retained
  routing_hint text,                   -- optional: 'work' | 'personal' | freeform
  interview_id uuid,                   -- set when mode = 'interview'
  created_at   timestamptz not null default now()
);
create index captures_user_idx on public.captures (user_id, created_at desc);

create table public.corrections (      -- explicit fixes; miner input every recompute
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  kind       text not null,            -- 'merge_people' | 'retype' | 'edit_fact' | ...
  payload    jsonb not null,           -- structured instruction the miner honors
  created_at timestamptz not null default now()
);
create index corrections_user_idx on public.corrections (user_id, created_at desc);

create table public.confirmations (    -- freshness-loop answers; miner input every recompute
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  canonical_id      uuid,              -- the node being confirmed / superseded
  result            text not null,     -- 'renew' | 'supersede' | 'unsure'
  payload           jsonb,             -- the new claim, if superseding
  source_capture_id uuid references public.captures(id),
  created_at        timestamptz not null default now()
);
create index confirmations_user_idx on public.confirmations (user_id, created_at desc);
create index confirmations_canonical_idx on public.confirmations (canonical_id);

create trigger captures_append_only
  before update or delete on public.captures
  for each row execute function public.forbid_mutation();
create trigger corrections_append_only
  before update or delete on public.corrections
  for each row execute function public.forbid_mutation();
create trigger confirmations_append_only
  before update or delete on public.confirmations
  for each row execute function public.forbid_mutation();
