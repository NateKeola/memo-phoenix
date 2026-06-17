-- PR0 / 0001: shared helpers + telemetry sink.
-- Lands first: no canonical dependency, and telemetry must be live from day one.

-- gen_random_uuid() is core in PG13+. pgcrypto is created defensively and is idempotent.
create extension if not exists pgcrypto with schema extensions;

-- Temporal class carried by every canonical row (spec 4.1, invariant 7).
create type public.temporal_class as enum ('evergreen', 'dated', 'decaying');

-- PRIMARY append-only guard. A BEFORE UPDATE/DELETE trigger using this raises,
-- because the migration owner and service_role bypass table GRANTs, so a REVOKE
-- alone cannot enforce append-only. (Invariant 1.)
create or replace function public.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'append-only table %: % is not permitted', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

-- Canonical history retention (invariant 6). AFTER insert/update/delete on a
-- canonical table writes a full row snapshot. SECURITY DEFINER so it can write
-- canonical_history regardless of the caller's RLS scope. canonical_history is
-- created in 0004; plpgsql resolves the reference at runtime, not creation.
create or replace function public.snapshot_canonical()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rec jsonb;
begin
  if tg_op = 'DELETE' then
    rec := to_jsonb(old);
  else
    rec := to_jsonb(new);
  end if;

  insert into public.canonical_history (user_id, table_name, row_id, op, snapshot)
  values (
    (rec->>'user_id')::uuid,
    tg_table_name,
    (rec->>'id')::uuid,
    tg_op,
    rec
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Telemetry sink. event_type is intentionally untyped (no CHECK) so new kinds
-- (tool_call, miner_run, cache, llm_call, error, ...) need no migration.
create table public.telemetry_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  event_type  text not null,
  name        text,
  duration_ms integer,
  attrs       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index telemetry_events_user_type_idx
  on public.telemetry_events (user_id, event_type, created_at desc);

create trigger telemetry_events_append_only
  before update or delete on public.telemetry_events
  for each row execute function public.forbid_mutation();
