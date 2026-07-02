-- 0017: mid-run visibility for miner runs.
--
-- miner_runs was written only at START (status='running') and END (done/error), so
-- a serverless mine killed at the timeout left a 'running' row with no signal: the
-- building/miner surfaces showed an endless in-progress state (observed live for
-- 1 to 9 hours), and the auto-run measure treated the zombie as active, silently
-- suppressing background mining. The miner now heartbeats at every pass boundary:
--
--   heartbeat_at  last sign of life; readers compute an EFFECTIVE status
--                 ('stalled') when a running row's heartbeat goes silent, and the
--                 lock reclaim keys on heartbeat age instead of started_at age (a
--                 legitimately long run keeps its lock as long as it beats; the old
--                 20-minute started_at threshold was SHORTER than a real 22-minute
--                 full recompute and could reclaim a LIVE run).
--   stage         where the run is (extract:3/26, canonical_people, freshness...),
--                 so a stall names the stage it died in.
--
-- miner_runs is operational state (mutable, no forbid_mutation); columns only.

alter table public.miner_runs add column if not exists heartbeat_at timestamptz;
alter table public.miner_runs add column if not exists stage text;
