-- 0021: Phase 1 precondition. Archive, then purge, the orphan canonical_history rows.
--
-- ============================================================================
-- DESTRUCTIVE MIGRATION ON A HARD APPEND-ONLY TABLE.
-- Requires the human destructive-migration label before merge.
-- It temporarily disables canonical_history_append_only, deletes the orphan rows,
-- and re-enables the trigger, with assertions that roll all of it back on any
-- mismatch.
-- ============================================================================
--
-- WHY THIS EXISTS
-- canonical_history rows carry the user_id of the canonical row that was snapshotted.
-- Two security guards (check-multiuser.mjs and check-miner-isolation.ts) seeded
-- canonical_* rows for throwaway auth users and then DELETED those auth users at
-- teardown. Seeding a canonical row fires snapshot_canonical(), which writes a
-- canonical_history row. canonical_history is hard append-only (forbid_mutation), so
-- teardown could never remove it, and once the auth user was gone no RLS policy
-- could reach it: the predicate is user_id = auth.uid() and a deleted user cannot
-- authenticate.
--
-- 578 such rows across 97 vanished users accumulated. They block the Phase 1 scope
-- backfill, which sets scope_id NOT NULL by joining user_id to that user's personal
-- scope: an orphan has no personal scope, so scope_id stays null and the NOT NULL
-- step fails and rolls back the Phase 1 migration.
--
-- The guard fix ships in this same PR and lands FIRST in the change order, so no new
-- orphans can be created. This migration clears the accumulated ones.
--
-- ATOMICITY, STATED PRECISELY
-- Section 2 below is a SINGLE plpgsql DO block containing the archive, the trigger
-- disable, the delete, the trigger re-enable and every assertion. A plpgsql block is
-- atomic in itself: any `raise exception` inside it rolls back everything the block
-- did, including the trigger disable. So the safety of this migration does NOT
-- depend on how the applier wraps the file.
--
-- For the record, neither applier splits on semicolons (both verified by reading the
-- code): the GitHub Action runs `supabase db push`, which applies each migration file
-- as a unit, and `scripts/db.mjs` sends the whole file plus its bookkeeping insert as
-- one query payload. The section 1 DDL is independently idempotent, so a re-run is
-- safe either way.
--
-- ARCHIVE, NOT DELETE
-- Nothing is destroyed without a copy. Every purged row is written to
-- audit_backup.canonical_history_orphan_archive as jsonb first, and the count is
-- asserted before a single row is removed.

-- ---------------------------------------------------------------------------
-- 1. The archive schema, locked down. Every statement here is idempotent.
--    audit_backup is the standing destination for archived or unreachable data.
--    It is NOT in public, so PostgREST does not expose it and the RLS sweep
--    (check-rls.mjs, which enumerates schemaname = 'public') never sees it.
--    Precedent: the 2026-07-02 per-user backups live here for the same reason.
-- ---------------------------------------------------------------------------
create schema if not exists audit_backup;

revoke all on schema audit_backup from anon, authenticated;
revoke all on all tables in schema audit_backup from anon, authenticated;
alter default privileges in schema audit_backup revoke all on tables from anon, authenticated;

create table if not exists audit_backup.canonical_history_orphan_archive (
  id          uuid primary key default gen_random_uuid(),
  row         jsonb not null,
  archived_at timestamptz not null default now(),
  reason      text not null
);

revoke all on audit_backup.canonical_history_orphan_archive from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Archive, then purge. One atomic block.
--
--    IDEMPOTENCY. The guard at the top fires ONLY in the exact "already applied"
--    state: zero orphans remain AND the archive holds exactly 578 rows. In that
--    case the block reports success and returns, so re-running a migration that
--    already succeeded prints a notice rather than a red assertion failure. The
--    condition is deliberately narrow. If ANY orphan exists the migration runs, and
--    every other state (orphans present with a full archive, or no orphans with an
--    empty archive) falls through to the assertions and stops loudly.
--
--    ROW COUNTS. The post-purge total is asserted RELATIVELY (post = pre - archived),
--    computed inside this block. It is deliberately not a hardcoded number: between
--    the Step 0b baseline and this migration reaching production, the pre-merge proof
--    runs `npm run security` twice, and each run still writes canonical_history rows
--    (the trigger is `after insert or update or delete` on every canonical table, so
--    a seeded row writes one going in and one at teardown). Those rows are owned by
--    the permanent guard accounts, so they are NOT orphans and must survive, but they
--    move the total. An absolute expectation would be stale on arrival.
--
--    The archive assertion stays hardcoded at 578 on purpose. It is a tripwire: the
--    guard fix stops new orphans, so 578 should still be exactly right, and if it is
--    not, something unexpected happened and the migration must stop.
-- ---------------------------------------------------------------------------
do $$
declare
  reason_tag    constant text := 'phase-1-precondition: user_id absent from auth.users';
  expected      constant int := 578;
  orphans_now   int;
  archived      int;
  pre_count     int;
  post_count    int;
  orphans_left  int;
  trg_state     char;
begin
  -- --- idempotency guard: exactly the "already applied" state, nothing wider ---
  select count(*) into orphans_now
  from public.canonical_history ch
  where not exists (select 1 from auth.users u where u.id = ch.user_id);

  select count(*) into archived
  from audit_backup.canonical_history_orphan_archive
  where reason = reason_tag;

  if orphans_now = 0 and archived = expected then
    raise notice '0021 is ALREADY APPLIED. % orphan rows remain and the archive holds exactly %. Nothing to do. THIS IS SUCCESS, not a failure, and no data was touched.', orphans_now, archived;
    return;
  end if;

  -- --- archive every orphan row, then assert the archive is complete ---
  -- canonical_history.user_id is NOT NULL, so there is no null case to handle here.
  insert into audit_backup.canonical_history_orphan_archive (row, reason)
  select to_jsonb(ch), reason_tag
  from public.canonical_history ch
  where not exists (select 1 from auth.users u where u.id = ch.user_id);

  select count(*) into archived
  from audit_backup.canonical_history_orphan_archive
  where reason = reason_tag;

  if archived <> expected then
    raise exception 'ARCHIVE ASSERTION FAILED: archive holds % rows, expected %. NOTHING HAS BEEN DELETED. The orphan count drifted since the Step 0b baseline (most likely the security harness ran under the OLD guard code). Re-baseline the counts, do not loosen this assertion.', archived, expected;
  end if;
  raise notice 'archive ok: % orphan rows preserved', archived;

  -- --- only now: disable the append-only trigger, purge, re-enable ---
  select count(*) into pre_count from public.canonical_history;

  alter table public.canonical_history disable trigger canonical_history_append_only;

  delete from public.canonical_history ch
  where not exists (select 1 from auth.users u where u.id = ch.user_id);

  alter table public.canonical_history enable trigger canonical_history_append_only;

  -- --- post-purge assertions; any failure rolls back the delete AND the disable ---
  select count(*) into post_count from public.canonical_history;
  if post_count <> pre_count - archived then
    raise exception 'ROWCOUNT ASSERTION FAILED: canonical_history went % -> %, but % rows were archived, so % was expected. The delete removed a different set than the archive captured.',
      pre_count, post_count, archived, pre_count - archived;
  end if;

  select count(*) into orphans_left
  from public.canonical_history ch
  where not exists (select 1 from auth.users u where u.id = ch.user_id);
  if orphans_left <> 0 then
    raise exception 'ORPHAN ASSERTION FAILED: % orphan rows remain after the purge.', orphans_left;
  end if;

  -- Read the real trigger state from pg_trigger. Do not assume the enable worked.
  -- tgenabled: 'O' = enabled (origin), 'D' = disabled, 'R'/'A' = replica/always.
  select t.tgenabled into trg_state
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'canonical_history'
    and t.tgname = 'canonical_history_append_only'
    and not t.tgisinternal;

  if trg_state is null then
    raise exception 'TRIGGER ASSERTION FAILED: canonical_history_append_only is MISSING. canonical_history would no longer be append-only.';
  end if;
  if trg_state = 'D' then
    raise exception 'TRIGGER ASSERTION FAILED: canonical_history_append_only is still DISABLED. canonical_history would no longer be append-only.';
  end if;

  raise notice 'purge ok: canonical_history % -> % (% archived), 0 orphans, append-only trigger enabled (tgenabled=%)',
    pre_count, post_count, archived, trg_state;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Assert the archive is not reachable by any client role. Runs in both the
--    fresh-apply and already-applied cases, so the lockdown is re-verified.
--
--    The PostgREST exposed-schemas setting lives in Supabase project config, not
--    in the database, so it is generally NOT readable from a migration session
--    (pgrst.db_schemas is set per PostgREST connection). This block therefore
--    checks it opportunistically and asserts the GRANTS instead, which are the
--    actual enforcement mechanism and ARE readable: even if a schema were exposed,
--    PostgREST cannot read it without USAGE on the schema.
--
--    A manual confirmation line for the exposed-schemas setting is in the PR body.
-- ---------------------------------------------------------------------------
do $$
declare
  exposed text;
begin
  if has_schema_privilege('anon', 'audit_backup', 'USAGE') then
    raise exception 'GRANT ASSERTION FAILED: role anon has USAGE on schema audit_backup.';
  end if;
  if has_schema_privilege('authenticated', 'audit_backup', 'USAGE') then
    raise exception 'GRANT ASSERTION FAILED: role authenticated has USAGE on schema audit_backup.';
  end if;
  if has_table_privilege('anon', 'audit_backup.canonical_history_orphan_archive', 'SELECT') then
    raise exception 'GRANT ASSERTION FAILED: role anon can SELECT the orphan archive.';
  end if;
  if has_table_privilege('authenticated', 'audit_backup.canonical_history_orphan_archive', 'SELECT') then
    raise exception 'GRANT ASSERTION FAILED: role authenticated can SELECT the orphan archive.';
  end if;

  exposed := current_setting('pgrst.db_schemas', true);
  if exposed is null or exposed = '' then
    raise notice 'pgrst.db_schemas is not readable from this session, as expected. Confirm manually that audit_backup is absent from the API exposed-schemas setting (see the PR body).';
  elsif position('audit_backup' in exposed) > 0 then
    raise exception 'EXPOSURE ASSERTION FAILED: audit_backup appears in the PostgREST exposed schemas (%).', exposed;
  else
    raise notice 'pgrst.db_schemas = %, audit_backup absent. Good.', exposed;
  end if;
end $$;
