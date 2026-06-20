-- 0015: user-set time-sensitivity on a follow-up.
--
-- The follow-up tab is time-aware: an item whose deadline has passed leaves the
-- main tab (it moves to a read-time "past" view, never deleted). Time-sensitivity
-- is INFERRED by the miner (a commitment with a concrete deadline is dated and
-- time-sensitive; an evergreen nudge like "call your dad" is not), and the user can
-- OVERRIDE it here. This is user state, so it lives in the companion_state overlay,
-- never in canonical (the miner stays the only canonical writer).
--
-- `time_sensitive`: the user's explicit override. null = use the inferred value
-- (a concrete deadline => time-sensitive); true/false = the user's choice.
-- The deadline itself reuses the existing `due_date` column (0012): the user's set
-- deadline, which overrides the miner's inferred one. Schema only; safe to apply.

alter table public.companion_state add column if not exists time_sensitive boolean;
