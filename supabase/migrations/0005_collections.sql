-- PR0 / 0005: hybrid collections (spec 4.5), DDL transcribed faithfully.
-- source_claim_ids on items stays NULLABLE (per the locked DDL). No `accepted`
-- column (would be gold-plating). History snapshots applied to both.

create table public.collections (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  name       text not null,          -- 'gift list', 'books to read', ...
  created_by text not null,          -- 'user' | 'miner_proposed'
  created_at timestamptz not null default now()
);
create index collections_user_idx on public.collections (user_id);

create table public.collection_items (
  id               uuid primary key default gen_random_uuid(),
  collection_id    uuid not null references public.collections(id),
  user_id          uuid not null,
  data             jsonb not null,    -- the item; may reference a person_id / place_id
  source_claim_ids uuid[],            -- nullable per the locked DDL
  created_at       timestamptz not null default now()
);
create index collection_items_collection_idx on public.collection_items (collection_id);
create index collection_items_user_idx on public.collection_items (user_id);

create trigger collections_hist
  after insert or update or delete on public.collections
  for each row execute function public.snapshot_canonical();
create trigger collection_items_hist
  after insert or update or delete on public.collection_items
  for each row execute function public.snapshot_canonical();
