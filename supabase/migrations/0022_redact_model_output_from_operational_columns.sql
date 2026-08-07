-- 0022: Redact model-authored content from shaped operational columns.
--
-- NOT DESTRUCTIVE IN THE 0021 SENSE. Every table touched here (miner_runs,
-- telemetry_events) is mutable operational state with NO append-only trigger:
-- mineWithLock already UPDATEs miner_runs on every run. This is a plain UPDATE.
-- No trigger disable, no destructive-migration label.
--
-- WHY THIS EXISTS
-- The standing rule is: ANYTHING PERSISTED TO A DATABASE COLUMN IS SHAPED, ANYTHING
-- WRITTEN TO STDOUT MAY BE FULL. Three emitters violated it and wrote model-authored
-- and user-authored content into columns that are supposed to hold ids, counts,
-- enums, positions and durations only:
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
-- All three emitters are fixed in the same PR and land FIRST in the change order, so
-- no new content can be written. This migration clears what accumulated.
--
-- A DELIBERATE EXCEPTION TO SOFT-DELETE-ONLY. The project archives rather than
-- deletes. This overwrites in place, and that is justified narrowly: the content
-- should never have been written, and archiving it to audit_backup would MOVE it,
-- not REMOVE it, which does not resolve the leak. There is no restore scenario for a
-- failed run's error string. IT IS NOT PRECEDENT FOR OVERWRITING ANYTHING ELSE.
-- Ground truth (captures, raw_*, corrections) and the knowledge graph are untouched
-- and remain soft-delete-only.
--
-- WHAT IS PRESERVED
-- The structural prefix, verbatim: which pass, which batch, what JSON.parse said,
-- the position, the rejected uuid. Only the prose is replaced, and the marker records
-- how many characters were dropped so the redaction is auditable.
--
-- ATOMICITY
-- One plpgsql DO block. A plpgsql block is atomic in itself, so any `raise exception`
-- rolls back every write the block made.
--
-- NO EXPECTED-COUNT TRIPWIRE, DELIBERATELY. 0021 asserted exactly 578 rows because a
-- drift there meant the guard fix had failed, which is a real alarm. Here a drift just
-- means the operator used their own app: telemetry_events is written on every capture,
-- and miner_runs on every mine. An exact count would be stale the moment Memo is used.
--
-- So the shape is: SNAPSHOT the matching ids, assert at least one matched, redact
-- exactly those ids, then assert exactly those ids are clean. Scoping the post-check to
-- the snapshot matters on a live table: an unscoped re-count would see a row the app
-- committed mid-migration and roll back the entire redaction over a row this run never
-- claimed to handle. Rows that arrive during the run are counted and reported as a
-- NOTICE telling the operator to re-run, never as a failure.
--
-- IDEMPOTENT
-- If zero content-bearing rows match, it raises a notice and returns without writing.
-- Re-running is a no-op, and re-running is also the correct response to the arrival
-- notice above.

do $$
declare
  -- Predicates are repeated verbatim in the snapshot, the update and the post-check.
  -- Keep them in sync; they are the definition of "content-bearing" for this migration.
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
begin
  -- 0. SNAPSHOT the ids that match right now. Everything below is scoped to these.

  -- miner_runs.error: a JSON slice after the parser message, or a quoted
  -- model-authored node label.
  select coalesce(array_agg(id), '{}')
    into err_ids
    from public.miner_runs
   where error is not null and error <> ''
     and (error ~ 'valid JSON \(.*\)\s*:\s*[{\[]' or error ~ 'node "[^"]+"');

  -- miner_runs.summary: any pass carrying a non-empty discrepancyItems array.
  select coalesce(array_agg(id), '{}')
    into summary_ids
    from public.miner_runs
   where summary is not null
     and exists (
       select 1
         from jsonb_array_elements(coalesce(summary->'passes', '[]'::jsonb)) p
        where jsonb_typeof(p->'discrepancyItems') = 'array'
          and jsonb_array_length(p->'discrepancyItems') > 0
     );

  -- telemetry_events.attrs: the capture event's verbatim routing_hint. ANY non-empty
  -- value, not just a long one: a four-character hint is still user text.
  select coalesce(array_agg(id), '{}')
    into attrs_ids
    from public.telemetry_events
   where attrs ? 'routing_hint'
     and coalesce(attrs->>'routing_hint', '') <> '';

  matched := coalesce(array_length(err_ids, 1), 0)
           + coalesce(array_length(summary_ids, 1), 0)
           + coalesce(array_length(attrs_ids, 1), 0);

  if matched = 0 then
    raise notice '0022 is ALREADY APPLIED. No content-bearing rows match in miner_runs.error, miner_runs.summary or telemetry_events.attrs. Nothing to do. THIS IS SUCCESS, not a failure, and no data was touched.';
    return;
  end if;

  raise notice '0022 redacting % row(s): miner_runs.error=%, miner_runs.summary=%, telemetry_events.attrs=%',
    matched,
    coalesce(array_length(err_ids, 1), 0),
    coalesce(array_length(summary_ids, 1), 0),
    coalesce(array_length(attrs_ids, 1), 0);

  -- 1. miner_runs.error. Keep everything up to the parser message's closing paren, or
  -- the rejected-id clause, and replace the rest with a marker recording the dropped
  -- character count. The predicate is repeated alongside the id scope so a row that
  -- changed since the snapshot is skipped rather than mangled.
  with redacted as (
    update public.miner_runs m
       set error = case
             -- parse failure: "...valid JSON (<structural message>): <MODEL JSON>"
             when m.error ~ 'valid JSON \(.*\)\s*:\s*[{\[]' then
               regexp_replace(m.error, '^(.*valid JSON \(.*\))\s*:\s*[\s\S]*$', '\1')
               || ' [redacted: ' || (length(m.error) - length(regexp_replace(m.error, '^(.*valid JSON \(.*\))\s*:\s*[\s\S]*$', '\1'))) || ' chars of model output removed by 0022]'
             -- provenance failure: '...node "<MODEL LABEL>": cited unknown raw id ...'
             else
               regexp_replace(m.error, 'node "[^"]+"', 'node [label redacted by 0022]')
           end
     where m.id = any(err_ids)
       and m.error is not null and m.error <> ''
       and (m.error ~ 'valid JSON \(.*\)\s*:\s*[{\[]' or m.error ~ 'node "[^"]+"')
    returning 1
  )
  select count(*) into redacted_errors from redacted;

  -- 2. miner_runs.summary. Drop discrepancyItems from every pass, keeping the shaped
  -- `discrepancies` COUNT and every other field. Nothing reads discrepancyItems back
  -- off the row; they are consumed in-run before mine() returns.
  with redacted as (
    update public.miner_runs m
       set summary = jsonb_set(
             m.summary,
             '{passes}',
             (
               select coalesce(jsonb_agg(p - 'discrepancyItems' order by ord), '[]'::jsonb)
                 from jsonb_array_elements(m.summary->'passes') with ordinality t(p, ord)
             )
           )
     where m.id = any(summary_ids)
       and m.summary is not null
    returning 1
  )
  select count(*) into redacted_summary from redacted;

  -- 3. telemetry_events.attrs. Replace the verbatim hint with its character count,
  -- which is what the emitter now records.
  with redacted as (
    update public.telemetry_events t
       set attrs = (t.attrs - 'routing_hint')
                   || jsonb_build_object('routing_hint_chars', length(coalesce(t.attrs->>'routing_hint', '')))
     where t.id = any(attrs_ids)
       and t.attrs ? 'routing_hint'
    returning 1
  )
  select count(*) into redacted_attrs from redacted;

  -- 4. POST-ASSERT, scoped to the snapshot. These must be zero: they are the rows this
  -- run claimed to fix.
  select count(*) into err_after
    from public.miner_runs
   where id = any(err_ids)
     and error is not null and error <> ''
     and (error ~ 'valid JSON \(.*\)\s*:\s*[{\[]' or error ~ 'node "[^"]+"');

  select count(*) into summary_after
    from public.miner_runs
   where id = any(summary_ids)
     and summary is not null
     and exists (
       select 1
         from jsonb_array_elements(coalesce(summary->'passes', '[]'::jsonb)) p
        where jsonb_typeof(p->'discrepancyItems') = 'array'
          and jsonb_array_length(p->'discrepancyItems') > 0
     );

  select count(*) into attrs_after
    from public.telemetry_events
   where id = any(attrs_ids)
     and attrs ? 'routing_hint'
     and coalesce(attrs->>'routing_hint', '') <> '';

  if err_after <> 0 then
    raise exception '0022 FAILED: % snapshotted miner_runs.error row(s) still carry model output. Rolled back.', err_after;
  end if;
  if summary_after <> 0 then
    raise exception '0022 FAILED: % snapshotted miner_runs.summary row(s) still carry discrepancyItems. Rolled back.', summary_after;
  end if;
  if attrs_after <> 0 then
    raise exception '0022 FAILED: % snapshotted telemetry_events.attrs row(s) still carry routing_hint. Rolled back.', attrs_after;
  end if;

  -- 5. Rows that started matching AFTER the snapshot. Not a failure: on a live table
  -- the app may have written one mid-run, and pre-deploy the old emitter is still
  -- running. Report and let the operator re-run. NEVER relax the guard instead.
  select
      (select count(*) from public.miner_runs
        where not (id = any(err_ids)) and error is not null and error <> ''
          and (error ~ 'valid JSON \(.*\)\s*:\s*[{\[]' or error ~ 'node "[^"]+"'))
    + (select count(*) from public.miner_runs
        where not (id = any(summary_ids)) and summary is not null
          and exists (select 1 from jsonb_array_elements(coalesce(summary->'passes', '[]'::jsonb)) p
                       where jsonb_typeof(p->'discrepancyItems') = 'array'
                         and jsonb_array_length(p->'discrepancyItems') > 0))
    + (select count(*) from public.telemetry_events
        where not (id = any(attrs_ids)) and attrs ? 'routing_hint'
          and coalesce(attrs->>'routing_hint', '') <> '')
    into arrived;

  if arrived > 0 then
    raise notice '0022 NOTE: % row(s) began matching AFTER this run snapshotted. The app was in use, or the emitter fix has not deployed yet. They are NOT redacted by this run. RE-RUN 0022. Do not relax the guard, exempt a column, or change the assertion.', arrived;
  end if;

  raise notice '0022 OK. Redacted % miner_runs.error, % miner_runs.summary, % telemetry_events.attrs. Every snapshotted row is clean.',
    redacted_errors, redacted_summary, redacted_attrs;
end $$;
