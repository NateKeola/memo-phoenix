-- PR3 / 0009: interview sessions.
--
-- One row per interview, so the daily-mode brief is inspectable (the briefing is
-- the part most likely to need tuning). This is mutable state (ended_at and the
-- conversation id are filled in when the interview ends), so it carries NO
-- append-only / history triggers. RLS scoped to the user; the user owns reads and
-- writes via their session (the routes use the RLS-scoped client).

create table public.interview_sessions (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null,
  mode                      text not null,          -- 'open' | 'daily'
  brief                     jsonb,                  -- the brief used in daily mode (null for open)
  elevenlabs_conversation_id text,
  started_at                timestamptz not null default now(),
  ended_at                  timestamptz
);
create index interview_sessions_user_idx on public.interview_sessions (user_id, started_at desc);

alter table public.interview_sessions enable row level security;
alter table public.interview_sessions force row level security;
create policy interview_sessions_sel on public.interview_sessions
  for select to authenticated using (user_id = auth.uid());
create policy interview_sessions_ins on public.interview_sessions
  for insert to authenticated with check (user_id = auth.uid());
create policy interview_sessions_upd on public.interview_sessions
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
