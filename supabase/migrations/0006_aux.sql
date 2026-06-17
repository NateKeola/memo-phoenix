-- PR0 / 0006: aux layer (spec 4.6).
-- open_threads and discrepancies are loose jsonb tables (discrepancies will feed
-- supersession in PR8). reconfirm_candidates is a COMPUTED view (open decision #9,
-- lean: computed until slow), filtered ONLY on temporality = 'decaying' and
-- valid_to is null. Confidence/salience thresholds (open decision #5) are applied
-- by the consumer in code, not baked into the migration. security_invoker = on so
-- the underlying canonical-table RLS applies to the querying user.

create table public.open_threads (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  data       jsonb not null default '{}'::jsonb,
  status     text not null default 'open',
  created_at timestamptz not null default now()
);
create index open_threads_user_idx on public.open_threads (user_id);

create table public.discrepancies (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  data       jsonb not null default '{}'::jsonb,
  resolved   boolean not null default false,
  created_at timestamptz not null default now()
);
create index discrepancies_user_idx on public.discrepancies (user_id);

create view public.reconfirm_candidates with (security_invoker = on) as
  select 'canonical_people'::text as table_name, id, user_id, label, confidence, salience, last_confirmed_at
    from public.canonical_people        where temporality = 'decaying' and valid_to is null
  union all
  select 'canonical_places_orgs', id, user_id, label, confidence, salience, last_confirmed_at
    from public.canonical_places_orgs   where temporality = 'decaying' and valid_to is null
  union all
  select 'canonical_projects', id, user_id, label, confidence, salience, last_confirmed_at
    from public.canonical_projects      where temporality = 'decaying' and valid_to is null
  union all
  select 'canonical_events', id, user_id, label, confidence, salience, last_confirmed_at
    from public.canonical_events        where temporality = 'decaying' and valid_to is null
  union all
  select 'canonical_facts', id, user_id, label, confidence, salience, last_confirmed_at
    from public.canonical_facts         where temporality = 'decaying' and valid_to is null
  union all
  select 'canonical_relationships', id, user_id, label, confidence, salience, last_confirmed_at
    from public.canonical_relationships where temporality = 'decaying' and valid_to is null
  union all
  select 'canonical_commitments', id, user_id, label, confidence, salience, last_confirmed_at
    from public.canonical_commitments   where temporality = 'decaying' and valid_to is null
  union all
  select 'insights', id, user_id, label, confidence, salience, last_confirmed_at
    from public.insights                where temporality = 'decaying' and valid_to is null;
