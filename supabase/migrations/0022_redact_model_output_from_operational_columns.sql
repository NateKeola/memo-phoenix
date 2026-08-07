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
-- One plpgsql DO block containing the pre-count assertions, the updates and the
-- post-count assertions. A plpgsql block is atomic in itself, so any `raise
-- exception` rolls back every write the block made.
--
-- IDEMPOTENT
-- If zero content-bearing rows remain, it raises a notice and returns without
-- writing. Re-running is a no-op.

do $$
declare
  err_dirty        int;
  summary_dirty    int;
  attrs_dirty      int;
  err_after        int;
  summary_after    int;
  attrs_after      int;
  redacted_errors  int;
  redacted_summary int;
  redacted_attrs   int;
begin
  -- Content-bearing row counts, by the same tests the security harness uses.
  -- miner_runs.error: either a JSON slice after the parser message, or a quoted
  -- model-authored node label.
  select count(*) into err_dirty
    from public.miner_runs
   where error is not null and error <> ''
     and (error ~ 'valid JSON \(.*\)\s*:\s*[{\[]' or error ~ 'node "[^"]+"');

  -- miner_runs.summary: any pass carrying a non-empty discrepancyItems array.
  select count(*) into summary_dirty
    from public.miner_runs
   where summary is not null
     and exists (
       select 1
         from jsonb_array_elements(coalesce(summary->'passes', '[]'::jsonb)) p
        where jsonb_typeof(p->'discrepancyItems') = 'array'
          and jsonb_array_length(p->'discrepancyItems') > 0
     );

  -- telemetry_events.attrs: the capture event's verbatim routing_hint.
  select count(*) into attrs_dirty
    from public.telemetry_events
   where attrs ? 'routing_hint'
     and coalesce(attrs->>'routing_hint', '') <> '';

  if err_dirty = 0 and summary_dirty = 0 and attrs_dirty = 0 then
    raise notice '0022 is ALREADY APPLIED. No content-bearing rows remain in miner_runs.error, miner_runs.summary or telemetry_events.attrs. Nothing to do. THIS IS SUCCESS, not a failure, and no data was touched.';
    return;
  end if;

  raise notice '0022 redacting: miner_runs.error=% row(s), miner_runs.summary=% row(s), telemetry_events.attrs=% row(s)', err_dirty, summary_dirty, attrs_dirty;

  -- 1. miner_runs.error. Keep everything up to the parser message's closing paren, or
  -- up to the rejected-id clause, and replace the rest with a marker recording the
  -- dropped character count.
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
     where m.error is not null and m.error <> ''
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
     where m.summary is not null
       and exists (
         select 1
           from jsonb_array_elements(coalesce(m.summary->'passes', '[]'::jsonb) ) p
          where jsonb_typeof(p->'discrepancyItems') = 'array'
            and jsonb_array_length(p->'discrepancyItems') > 0
       )
    returning 1
  )
  select count(*) into redacted_summary from redacted;

  -- 3. telemetry_events.attrs. Replace the verbatim hint with its character count,
  -- which is what the emitter now records.
  with redacted as (
    update public.telemetry_events t
       set attrs = (t.attrs - 'routing_hint')
                   || jsonb_build_object('routing_hint_chars', length(coalesce(t.attrs->>'routing_hint', '')))
     where t.attrs ? 'routing_hint'
       and coalesce(t.attrs->>'routing_hint', '') <> ''
    returning 1
  )
  select count(*) into redacted_attrs from redacted;

  -- Post-assertions: zero content-bearing rows may remain anywhere.
  select count(*) into err_after
    from public.miner_runs
   where error is not null and error <> ''
     and (error ~ 'valid JSON \(.*\)\s*:\s*[{\[]' or error ~ 'node "[^"]+"');

  select count(*) into summary_after
    from public.miner_runs
   where summary is not null
     and exists (
       select 1
         from jsonb_array_elements(coalesce(summary->'passes', '[]'::jsonb)) p
        where jsonb_typeof(p->'discrepancyItems') = 'array'
          and jsonb_array_length(p->'discrepancyItems') > 0
     );

  select count(*) into attrs_after
    from public.telemetry_events
   where attrs ? 'routing_hint'
     and coalesce(attrs->>'routing_hint', '') <> '';

  if err_after <> 0 then
    raise exception '0022 FAILED: % miner_runs.error row(s) still carry model output. Rolled back.', err_after;
  end if;
  if summary_after <> 0 then
    raise exception '0022 FAILED: % miner_runs.summary row(s) still carry discrepancyItems. Rolled back.', summary_after;
  end if;
  if attrs_after <> 0 then
    raise exception '0022 FAILED: % telemetry_events.attrs row(s) still carry routing_hint. Rolled back.', attrs_after;
  end if;

  raise notice '0022 OK. Redacted % miner_runs.error, % miner_runs.summary, % telemetry_events.attrs. Zero content-bearing rows remain.', redacted_errors, redacted_summary, redacted_attrs;
end $$;
