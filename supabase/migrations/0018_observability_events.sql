-- 0018: durable, admin-only observability layer.
--
-- "Works on my laptop" hides failures on other devices/users. This is the persistent
-- store that makes subsystem status + errors visible after the fact: auth, text and
-- voice capture, the Scribe/transcript path, the ElevenLabs interview, the miner
-- pipeline (which already has miner_runs heartbeat/stage), the cron, and the
-- surfaces. It complements telemetry_events (a write-only stream with no reader) and
-- miner_runs (run state) with a purpose-built, readable observability record that the
-- admin console reads.
--
-- PRIVACY: this table stores STATUS, ERROR TYPES/MESSAGES, TIMINGS, and METADATA
-- ONLY. It NEVER stores user content (no transcripts, no capture bodies) or secrets.
-- The writer (lib/observability.ts) enforces this; the schema keeps only shaped
-- columns + a metadata jsonb for counts/ids/flags.
--
-- Scope: user_id is set when an event relates to a user, and NULL for system events
-- (cron, config). Mutable operational state, no append-only/history trigger.

create table public.observability_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid,                         -- nullable: system/cron/config events have no user
  subsystem     text not null,                -- auth|capture_text|capture_memo|scribe|interview|onboarding|miner|cron|surface|api
  event         text not null,                -- short event name (start|ok|error|connect|disconnect|pause|resume|...)
  level         text not null default 'info', -- info|warn|error
  status        text,                         -- ok|error|started|... (nullable)
  duration_ms   integer,
  error_type    text,                         -- error class/name only
  error_message text,                         -- error message only, NEVER user content
  meta          jsonb not null default '{}',  -- metadata only (counts, ids, flags); no content/secrets
  created_at    timestamptz not null default now()
);
create index observability_events_recent_idx on public.observability_events (created_at desc);
create index observability_events_user_idx on public.observability_events (user_id, created_at desc);
create index observability_events_sub_idx on public.observability_events (subsystem, created_at desc);

-- RLS: FORCED, scoped to the user (defense in depth). Writes are SERVICE-ROLE ONLY
-- (no client insert policy). The admin observability console reads across users via
-- the service-role client, gated in code by isOperator (the same operator-mediated
-- pattern as the cron sweep and invites); RLS still blocks every non-service client.
alter table public.observability_events enable row level security;
alter table public.observability_events force row level security;
create policy observability_events_sel on public.observability_events
  for select to authenticated using (user_id = auth.uid());
