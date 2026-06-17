-- PR0 / 0004: canonical layer (spec 4.4). Columns kept LOOSE per open decision #3
-- (emit loose, observe real captures, freeze later): each type table carries the
-- identical mandatory shared block (invariants 2, 7) plus one `label`, a `data`
-- jsonb, and a `summary`. NO type-specific columns and NO foreign keys are
-- ordained, including NO self-FK on superseded_by: a self-FK has the same problem
-- as an inter-canonical FK, since a row could point at one the nightly recompute
-- removes. The miner sets and validates superseded_by in code (PR1).

-- History store. Append-only; written only by the snapshot_canonical() trigger.
create table public.canonical_history (
  id          bigint generated always as identity primary key,
  user_id     uuid not null,
  table_name  text not null,
  row_id      uuid not null,
  op          text not null,          -- 'INSERT' | 'UPDATE' | 'DELETE'
  snapshot    jsonb not null,
  recorded_at timestamptz not null default now()
);
create index canonical_history_lookup_idx on public.canonical_history (table_name, row_id, recorded_at desc);
create index canonical_history_user_idx on public.canonical_history (user_id);

create trigger canonical_history_append_only
  before update or delete on public.canonical_history
  for each row execute function public.forbid_mutation();

-- The 8 canonical type tables (Stage A: people, places_orgs; Stage B: projects,
-- events, facts; Stage C: relationships, commitments, insights), one shared shape.
do $do$
declare
  t text;
  canon_tables text[] := array[
    'canonical_people', 'canonical_places_orgs', 'canonical_projects',
    'canonical_events', 'canonical_facts', 'canonical_relationships',
    'canonical_commitments', 'insights'
  ];
begin
  foreach t in array canon_tables loop
    execute format($ddl$
      create table public.%I (
        id                uuid primary key default gen_random_uuid(),
        user_id           uuid not null,
        label             text,
        data              jsonb not null default '{}'::jsonb,
        source_claim_ids  uuid[] not null default '{}',          -- invariant 2
        temporality       public.temporal_class not null,         -- NO default; miner classifies
        valid_from        timestamptz not null default now(),
        valid_to          timestamptz,                            -- null = current
        superseded_by     uuid,                                   -- plain column, NO constraint
        confidence        real not null default 1.0,
        last_confirmed_at timestamptz,
        salience          real not null default 0,
        summary           text,
        created_at        timestamptz not null default now()
      );
    $ddl$, t);

    execute format('create index %I on public.%I (user_id);', t || '_user_idx', t);
    execute format('create index %I on public.%I (user_id) where valid_to is null;', t || '_current_idx', t);
    execute format('create index %I on public.%I using gin (source_claim_ids);', t || '_provenance_idx', t);
    execute format('create index %I on public.%I (temporality) where valid_to is null;', t || '_decay_idx', t);
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.snapshot_canonical();',
      t || '_hist', t
    );
  end loop;
end;
$do$;
