-- PR0 / 0007: RLS on EVERY table, FORCED, scoped to user_id = auth.uid().
-- The write split encodes invariants 1 and 4:
--   RW bucket  (input tables): authenticated may SELECT + INSERT. UPDATE/DELETE are
--              blocked by the append-only triggers; REVOKE is a secondary layer.
--   RO bucket  (canonical, history, telemetry, aux): authenticated may only SELECT.
--              Writes come solely from service_role, which bypasses RLS. This is
--              invariant 4: canonical is never edited directly by the client.
-- FORCE RLS subjects the table owner too; service_role/postgres carry BYPASSRLS,
-- so the miner and the SECURITY DEFINER history trigger still write.

-- Read-write bucket: SELECT + INSERT policies.
do $do$
declare
  t text;
  rw_tables text[] := array[
    'captures', 'corrections', 'confirmations',
    'raw_people', 'raw_places_orgs', 'raw_projects', 'raw_events',
    'raw_facts', 'raw_relationships', 'raw_commitments', 'raw_collection_mentions',
    'collections', 'collection_items'
  ];
begin
  foreach t in array rw_tables loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('alter table public.%I force row level security;', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id = auth.uid());',
      t || '_sel', t
    );
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (user_id = auth.uid());',
      t || '_ins', t
    );
  end loop;
end;
$do$;

-- Read-only bucket: SELECT policy only (no client write surface).
do $do$
declare
  t text;
  ro_tables text[] := array[
    'canonical_people', 'canonical_places_orgs', 'canonical_projects',
    'canonical_events', 'canonical_facts', 'canonical_relationships',
    'canonical_commitments', 'insights',
    'canonical_history', 'telemetry_events', 'discrepancies', 'open_threads'
  ];
begin
  foreach t in array ro_tables loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('alter table public.%I force row level security;', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id = auth.uid());',
      t || '_sel', t
    );
  end loop;
end;
$do$;

-- Secondary append-only layer: strip UPDATE/DELETE grants from the client roles.
revoke update, delete on
  public.captures, public.corrections, public.confirmations,
  public.telemetry_events, public.canonical_history,
  public.raw_people, public.raw_places_orgs, public.raw_projects, public.raw_events,
  public.raw_facts, public.raw_relationships, public.raw_commitments, public.raw_collection_mentions
from authenticated, anon;
