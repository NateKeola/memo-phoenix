-- 0022: Redact model-authored content from shaped operational columns.
--
-- ============================================================================
-- DESTRUCTIVE MIGRATION ON A HARD APPEND-ONLY TABLE.
-- Requires the human destructive-migration label before merge.
-- It temporarily disables telemetry_events_append_only, updates 5 rows, and
-- re-enables the trigger, with assertions that roll all of it back on any
-- mismatch. Same class as 0021.
-- ============================================================================
--
-- WHY THIS EXISTS
-- The standing rule is: ANYTHING PERSISTED TO A DATABASE COLUMN IS SHAPED, ANYTHING
-- WRITTEN TO STDOUT MAY BE FULL. Three emitters violated it and wrote model-authored
-- and user-authored content into columns that hold ids, counts, enums, positions and
-- durations only:
--
--   1. miner_runs.error       parseModelObject embedded a 200-character slice of the
--                             model's response in the thrown Error, and the node
--                             validator embedded the model-chosen canonical LABEL
--                             (a real person's name) in the error context.
--   2. miner_runs.summary     PassResult.discrepancyItems carries model-authored
--                             `subject` and `description` prose about real people.
--   3. telemetry_events.attrs the capture event carried the user-authored
--                             routing_hint verbatim.
--
-- All three emitters are fixed and already merged (PR #48), so no new content is
-- being written. This clears what accumulated.
--
-- WHY THE APPEND-ONLY TRIGGER COMES OFF, ONCE
-- telemetry_events is append-only for the same reason canonical_history is: the
-- trigger is a promise that the record was not retroactively edited. Redacting breaks
-- that promise and nothing avoids it, so it is broken ONCE, deliberately, and recorded
-- here and in the CLAUDE.md decision log. THIS IS NOT PRECEDENT. Any future disable
-- needs its own explicit justification and the destructive-migration label.
--
-- UPDATE, NOT DELETE. An UPDATE removes only routing_hint and keeps the timestamps,
-- event names and every other attribute. A DELETE would throw away real telemetry to
-- solve a content problem.
--
-- A DELIBERATE EXCEPTION TO SOFT-DELETE-ONLY, for the same reason: the content should
-- never have been written, and archiving it to audit_backup would MOVE it, not REMOVE
-- it. Ground truth (captures, raw_*, corrections) and the knowledge graph are
-- untouched and remain soft-delete-only.
--
-- ONE PREDICATE PER COLUMN
-- Section 1 defines the detect + redact pair for each column as SQL functions. The
-- snapshot, the UPDATE guard, the post-check AND scripts/check-obs-db.mjs all call the
-- SAME function. Three hand-copied predicates that must agree is the bug class that
-- has now bitten twice (a regex found 1 of 3 dirty columns; a claim that neither table
-- was append-only was never checked). The functions are the single definition.
--
-- ATOMICITY
-- Section 2 is one plpgsql DO block. A plpgsql block is atomic in itself, so any
-- `raise exception` rolls back every write it made, INCLUDING the trigger disable.
--
-- NO EXPECTED-COUNT TRIPWIRE, DELIBERATELY. 0021 asserted exactly 578 rows because a
-- drift there meant the guard fix had failed. Here a drift just means the operator used
-- their own app: telemetry_events is written on every capture and miner_runs on every
-- mine. The shape is SNAPSHOT the matching ids, assert at least one matched, redact
-- exactly those ids, assert exactly those ids are clean. Rows that arrive mid-run are
-- reported as a NOTICE telling the operator to re-run, never as a failure.
--
-- IDEMPOTENT, AND THE TRIGGER IS NEVER TOUCHED ON A NO-OP RUN
-- If zero rows match, the block raises a notice and RETURNS BEFORE the disable. The
-- steady-state re-run therefore never disables anything. This ordering is load-bearing:
-- a disable placed above that return would commit with the transaction and leave the
-- table permanently unprotected on the very next run.

-- ============================================================================
-- SECTION 1: the single definition of "content-bearing" per column.
-- create or replace, so re-applying is safe. SECURITY INVOKER (the default): these
-- must NOT be SECURITY DEFINER, because check-rls.mjs asserts snapshot_canonical is
-- the only SECURITY DEFINER function in public.
-- ============================================================================

-- The routing_hint values that are CODE-AUTHORED enums rather than user text.
-- Enumerated from the codebase: app/people/new/actions.ts:28 ('contact') and :53
-- ('contact_import') are the only literals ever passed as routingHint. Every other
-- value originates from the user typing into components/capture-text-form.tsx.
-- KEEP IN SYNC with ROUTING_HINT_CONSTANTS in lib/captures.ts (two languages, so the
-- list cannot be physically shared; the TS side is the source of truth).
create or replace function public.mp_routing_hint_is_code_constant(hint text)
returns boolean language sql immutable as $fn$
  select hint is not null and hint = any (array['contact', 'contact_import']);
$fn$;

-- miner_runs.error: a JSON slice after the parser message, or a quoted model-authored
-- node label. Non-greedy so the anchor cannot run past the parser message's closing
-- paren into the model output (see mp_error_redact).
create or replace function public.mp_error_has_content(err text)
returns boolean language sql immutable as $fn$
  select err is not null
     and err <> ''
     and (err ~ 'valid JSON \(.*?\)\s*:\s*[{\[]' or err ~ 'node "[^"]+"');
$fn$;

-- Keep the structural prefix VERBATIM, drop the prose, and record the exact number of
-- content characters removed.
--
-- The `.*?` is non-greedy deliberately. Greedy `.*` anchors on the LAST ')' followed by
-- ':' anywhere in the string, so an error whose model output contains '): {' would keep
-- part of that output in the "kept" prefix. Verified live: on
--   '... valid JSON (Expected token at position 9): {"a":"USC (2019): {surf}","b":1}'
-- greedy keeps '...(Expected token at position 9): {"a":"USC (2019)' and non-greedy
-- correctly keeps '...(Expected token at position 9)'.
--
-- The 'g' flag on the node-label branch replaces EVERY occurrence; without it a second
-- 'node "..."' would survive and trip the post-check.
create or replace function public.mp_error_redact(err text)
returns text language sql immutable as $fn$
  select case
    when err is null or err = '' then err
    when err ~ 'valid JSON \(.*?\)\s*:\s*[{\[]' then
      regexp_replace(err, '^(.*?valid JSON \(.*?\))\s*:\s*[\s\S]*$', '\1')
      || ' [redacted: '
      -- the content length ONLY: this strips the '<ws>:<ws>' delimiter as well as the
      -- prefix, so the count excludes the 2-character ': ' separator. The previous
      -- form subtracted prefix length from total length and overstated by 2.
      || length(regexp_replace(err, '^.*?valid JSON \(.*?\)\s*:\s*', ''))
      || ' chars of model output removed by 0022]'
    else
      regexp_replace(err, 'node "[^"]+"', 'node [label redacted by 0022]', 'g')
  end;
$fn$;

-- miner_runs.summary: any pass carrying a non-empty discrepancyItems array.
create or replace function public.mp_summary_has_content(summ jsonb)
returns boolean language sql immutable as $fn$
  select summ is not null
     and exists (
       select 1
         from jsonb_array_elements(
                case when jsonb_typeof(summ->'passes') = 'array'
                     then summ->'passes' else '[]'::jsonb end) p
        where jsonb_typeof(p->'discrepancyItems') = 'array'
          and jsonb_array_length(p->'discrepancyItems') > 0
     );
$fn$;

-- Drop discrepancyItems from every pass, keeping the shaped `discrepancies` COUNT,
-- the pass ORDER, and every other field. Nothing reads discrepancyItems back off the
-- row: derivation consumes them in-run before mine() returns.
create or replace function public.mp_summary_redact(summ jsonb)
returns jsonb language sql immutable as $fn$
  select case
    when summ is null then summ
    when jsonb_typeof(summ->'passes') <> 'array' then summ
    else jsonb_set(summ, '{passes}', (
           select coalesce(jsonb_agg(p - 'discrepancyItems' order by ord), '[]'::jsonb)
             from jsonb_array_elements(summ->'passes') with ordinality t(p, ord)
         ))
  end;
$fn$;

-- telemetry_events.attrs: a routing_hint that is NOT a known code-authored constant.
-- ANY non-empty user value counts, not just a long one: a four-character hint is still
-- user text. A code constant is left alone, which keeps 1 of the 6 live rows out of the
-- dirty set entirely, so one fewer append-only row is edited.
create or replace function public.mp_attrs_has_content(a jsonb)
returns boolean language sql immutable as $fn$
  select a is not null
     and a ? 'routing_hint'
     and coalesce(a->>'routing_hint', '') <> ''
     and not public.mp_routing_hint_is_code_constant(a->>'routing_hint');
$fn$;

-- Replace the user-typed hint with its character count, which is what the emitter now
-- records. A code constant is preserved verbatim as the enum it is.
create or replace function public.mp_attrs_redact(a jsonb)
returns jsonb language sql immutable as $fn$
  select case
    when a is null then a
    when not (a ? 'routing_hint') then a
    when public.mp_routing_hint_is_code_constant(a->>'routing_hint') then a
    else (a - 'routing_hint')
         || jsonb_build_object('routing_hint_chars', length(coalesce(a->>'routing_hint', '')))
  end;
$fn$;

-- ============================================================================
-- SECTION 2: the redaction.
-- ============================================================================

do $$
declare
  err_ids          uuid[];
  summary_ids      uuid[];
  attrs_ids        uuid[];
  matched          int;
  err_after        int;
  summary_after    int;
  attrs_after      int;
  arrived          int;
  redacted_errors  int;
  redacted_summary int;
  redacted_attrs   int;
  trg_state        "char";
begin
  -- 0. SNAPSHOT the ids that match right now. Everything below is scoped to these.
  select coalesce(array_agg(id), '{}') into err_ids
    from public.miner_runs where public.mp_error_has_content(error);

  select coalesce(array_agg(id), '{}') into summary_ids
    from public.miner_runs where public.mp_summary_has_content(summary);

  select coalesce(array_agg(id), '{}') into attrs_ids
    from public.telemetry_events where public.mp_attrs_has_content(attrs);

  matched := coalesce(array_length(err_ids, 1), 0)
           + coalesce(array_length(summary_ids, 1), 0)
           + coalesce(array_length(attrs_ids, 1), 0);

  -- THE EARLY RETURN MUST STAY ABOVE THE TRIGGER DISABLE. On the steady-state re-run
  -- this returns without ever touching the trigger. A disable above this line would
  -- commit with the transaction and leave telemetry_events permanently unprotected.
  if matched = 0 then
    raise notice '0022 is ALREADY APPLIED. No content-bearing rows match in miner_runs.error, miner_runs.summary or telemetry_events.attrs. The append-only trigger was NOT touched. THIS IS SUCCESS, not a failure, and no data was changed.';
    return;
  end if;

  raise notice '0022 redacting % row(s): miner_runs.error=%, miner_runs.summary=%, telemetry_events.attrs=%',
    matched,
    coalesce(array_length(err_ids, 1), 0),
    coalesce(array_length(summary_ids, 1), 0),
    coalesce(array_length(attrs_ids, 1), 0);

  -- 1. miner_runs (NOT append-only; no trigger handling needed).
  with redacted as (
    update public.miner_runs m
       set error = public.mp_error_redact(m.error)
     where m.id = any(err_ids)
       and public.mp_error_has_content(m.error)
    returning 1
  )
  select count(*) into redacted_errors from redacted;

  with redacted as (
    update public.miner_runs m
       set summary = public.mp_summary_redact(m.summary)
     where m.id = any(summary_ids)
       and public.mp_summary_has_content(m.summary)
    returning 1
  )
  select count(*) into redacted_summary from redacted;

  -- 2. telemetry_events IS append-only. Disable the trigger for exactly this one
  -- statement and re-enable immediately, keeping the unprotected window as small as
  -- possible. Any raise below rolls back the update AND the disable together.
  alter table public.telemetry_events disable trigger telemetry_events_append_only;

  with redacted as (
    update public.telemetry_events t
       set attrs = public.mp_attrs_redact(t.attrs)
     where t.id = any(attrs_ids)
       and public.mp_attrs_has_content(t.attrs)
    returning 1
  )
  select count(*) into redacted_attrs from redacted;

  alter table public.telemetry_events enable trigger telemetry_events_append_only;

  -- 3. POST-ASSERT, scoped to the snapshot, using the SAME functions as the snapshot.
  select count(*) into err_after
    from public.miner_runs where id = any(err_ids) and public.mp_error_has_content(error);
  select count(*) into summary_after
    from public.miner_runs where id = any(summary_ids) and public.mp_summary_has_content(summary);
  select count(*) into attrs_after
    from public.telemetry_events where id = any(attrs_ids) and public.mp_attrs_has_content(attrs);

  if err_after <> 0 then
    raise exception '0022 FAILED: % snapshotted miner_runs.error row(s) still carry model output. Rolled back.', err_after;
  end if;
  if summary_after <> 0 then
    raise exception '0022 FAILED: % snapshotted miner_runs.summary row(s) still carry discrepancyItems. Rolled back.', summary_after;
  end if;
  if attrs_after <> 0 then
    raise exception '0022 FAILED: % snapshotted telemetry_events.attrs row(s) still carry a user routing_hint. Rolled back.', attrs_after;
  end if;

  -- 4. Read the REAL trigger state from pg_trigger. Do not assume the enable worked.
  -- tgenabled: 'O' = enabled (origin), 'D' = disabled, 'R'/'A' = replica/always.
  select t.tgenabled into trg_state
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'telemetry_events'
     and t.tgname = 'telemetry_events_append_only'
     and not t.tgisinternal;

  if trg_state is null then
    raise exception 'TRIGGER ASSERTION FAILED: telemetry_events_append_only is MISSING. telemetry_events would no longer be append-only.';
  end if;
  if trg_state = 'D' then
    raise exception 'TRIGGER ASSERTION FAILED: telemetry_events_append_only is still DISABLED. telemetry_events would no longer be append-only.';
  end if;

  -- 5. Rows that started matching AFTER the snapshot. Not a failure: on a live table
  -- the app may have written one mid-run. Report and let the operator re-run.
  select
      (select count(*) from public.miner_runs
        where not (id = any(err_ids)) and public.mp_error_has_content(error))
    + (select count(*) from public.miner_runs
        where not (id = any(summary_ids)) and public.mp_summary_has_content(summary))
    + (select count(*) from public.telemetry_events
        where not (id = any(attrs_ids)) and public.mp_attrs_has_content(attrs))
    into arrived;

  if arrived > 0 then
    raise notice '0022 NOTE: % row(s) began matching AFTER this run snapshotted. RE-RUN 0022. Do not relax the guard, exempt a column, or change the assertion.', arrived;
  end if;

  raise notice '0022 OK. Redacted % miner_runs.error, % miner_runs.summary, % telemetry_events.attrs. Every snapshotted row is clean and telemetry_events_append_only is enabled (tgenabled=%).',
    redacted_errors, redacted_summary, redacted_attrs, trg_state;
end $$;
