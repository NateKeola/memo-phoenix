-- PR0 / 0003: raw layer (spec 4.3, invariant 1: append-only + capture_id provenance).
-- The 8 working-set sections (exact set is open decision #3) share one loose shape,
-- created via a DO loop so the shape cannot drift. No embedding column (that is PR6).

do $do$
declare
  t text;
  raw_tables text[] := array[
    'raw_people', 'raw_places_orgs', 'raw_projects', 'raw_events',
    'raw_facts', 'raw_relationships', 'raw_commitments', 'raw_collection_mentions'
  ];
begin
  foreach t in array raw_tables loop
    execute format($ddl$
      create table public.%I (
        id         uuid primary key default gen_random_uuid(),
        capture_id uuid not null references public.captures(id),
        user_id    uuid not null,
        data       jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
    $ddl$, t);

    execute format('create index %I on public.%I (user_id, created_at desc);', t || '_user_idx', t);
    execute format('create index %I on public.%I (capture_id);', t || '_capture_idx', t);
    execute format(
      'create trigger %I before update or delete on public.%I for each row execute function public.forbid_mutation();',
      t || '_append_only', t
    );
  end loop;
end;
$do$;
