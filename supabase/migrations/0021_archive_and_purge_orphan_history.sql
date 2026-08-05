-- 0021: Phase 1 precondition. Archive, then purge, the orphan canonical_history rows.
--
-- ============================================================================
-- DESTRUCTIVE MIGRATION ON A HARD APPEND-ONLY TABLE.
-- Requires the human destructive-migration label before merge.
-- It temporarily disables canonical_history_append_only, deletes 578 rows, and
-- re-enables the trigger, all in one transaction with assertions that roll the
-- whole thing back on any mismatch.
-- ============================================================================
--
-- WHY THIS EXISTS
-- canonical_history rows carry the user_id of the canonical row that was snapshotted.
-- Two security guards (check-multiuser.mjs and check-miner-isolation.ts) seeded
-- canonical_* rows for throwaway auth users and then DELETED those auth users at
-- teardown. Seeding a canonical row fires snapshot_canonical(), which writes a
-- canonical_history row. canonical_history is hard append-only (forbid_mutation), so
-- teardown could never remove those rows, and once the auth user was gone no RLS
-- policy could ever reach them again: the predicate is user_id = auth.uid() and a
-- deleted user cannot authenticate.
--
-- 578 such rows across 97 vanished users accumulated. They block the Phase 1 scope
-- backfill, which sets scope_id NOT NULL by joining user_id to that user's personal
-- scope: an orphan has no personal scope, so scope_id stays null and the NOT NULL
-- step fails and rolls back the Phase 1 migration.
--
-- The guard fix ships in this same PR and lands FIRST in the change order, so no new
-- orphans can be created. This migration clears the accumulated ones.
--
-- TRANSACTION SEMANTICS
-- The whole file is submitted as one multi-statement query and therefore runs in a
-- single implicit transaction (this repo's existing migrations rely on the same
-- property; none use explicit begin/commit). Any `raise exception` below rolls back
-- every statement in this file, including the trigger disable.
--
-- ARCHIVE, NOT DELETE
-- Nothing is destroyed without a copy. Every purged row is written to
-- audit_backup.canonical_history_orphan_archive as jsonb first, and the count is
-- asserted before a single row is removed.

-- ---------------------------------------------------------------------------
-- 1. The archive schema, locked down.
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
-- 2. Archive every orphan row, then assert the archive is complete.
--    An orphan is a canonical_history row whose user_id has no auth.users match.
--    canonical_history.user_id is NOT NULL, so there is no null case to handle.
-- ---------------------------------------------------------------------------
insert into audit_backup.canonical_history_orphan_archive (row, reason)
select to_jsonb(ch), 'phase-1-precondition: user_id absent from auth.users'
from public.canonical_history ch
where not exists (select 1 from auth.users u where u.id = ch.user_id);

do $$
declare
  archived  int;
  expected  constant int := 578;
begin
  select count(*) into archived
  from audit_backup.canonical_history_orphan_archive
  where reason = 'phase-1-precondition: user_id absent from auth.users';

  if archived <> expected then
    raise exception 'ARCHIVE ASSERTION FAILED: archived % rows, expected %. Nothing has been deleted. The orphan count drifted since the Step 0b baseline (most likely npm run security was run under the OLD guard code). Re-baseline the counts, do not loosen this assertion.', archived, expected;
  end if;
  raise notice 'archive ok: % orphan rows preserved', archived;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Purge, with RELATIVE assertions computed in the same transaction.
--
--    The row count is deliberately NOT hardcoded. Between the Step 0b baseline and
--    this migration reaching production, the pre-merge proof runs `npm run security`
--    twice, and each run still writes canonical_history rows (the trigger fires on
--    insert AND delete for every seeded canonical row). Those new rows are owned by
--    the permanent guard accounts, so they are NOT orphans and must survive, but
--    they do move the total. An absolute expectation would be stale on arrival.
--
--    So: capture the pre-purge count, then assert post = pre - archived. That holds
--    no matter how many legitimate rows arrived in between, and it still proves the
--    purge removed exactly the archived set and nothing else.
--
--    The archive assertion above stays hardcoded at 578 on purpose. It is a
--    tripwire: the guard fix stops new orphans, so 578 should still be exactly
--    right, and if it is not, something unexpected happened and the migration must
--    stop rather than proceed.
--
--    Disable, delete, re-enable and assert all live in one DO block so the
--    pre-purge count is in scope for the post-purge comparison. Any raise below
--    rolls back the delete AND the trigger disable together, so canonical_history
--    can never be left unprotected.
-- ---------------------------------------------------------------------------
do $$
declare
  pre_count     int;
  archived      int;
  post_count    int;
  orphans_left  int;
  trg_state     char;
begin
  select count(*) into pre_count from public.canonical_history;
  select count(*) into archived
  from audit_backup.canonical_history_orphan_archive
  where reason = 'phase-1-precondition: user_id absent from auth.users';

  alter table public.canonical_history disable trigger canonical_history_append_only;

  delete from public.canonical_history ch
  where not exists (select 1 from auth.users u where u.id = ch.user_id);

  alter table public.canonical_history enable trigger canonical_history_append_only;

  select count(*) into post_count from public.canonical_history;
  if post_count <> pre_count - archived then
    raise exception 'ROWCOUNT ASSERTION FAILED: canonical_history went % -> %, but % rows were archived. Expected % after the purge. The delete removed a different set than the archive captured.',
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
-- 5. Assert the archive is not reachable by any client role.
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
