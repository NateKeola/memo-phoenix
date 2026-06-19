-- PR (add context from anywhere): the capture-with-target mechanism plus light
-- follow-up tracking.

-- A capture can now know what it is ABOUT: a person, a commitment, or a chat
-- topic. The miner honors this so the extracted context attaches to the intended
-- thing rather than guessing. captures stays append-only (these are set at insert
-- time only; the append-only trigger still forbids UPDATE/DELETE).
alter table public.captures add column if not exists target_kind text;  -- 'person' | 'commitment' | 'topic'
alter table public.captures add column if not exists target_id uuid;    -- canonical id of the target (null for a free topic)

-- Light, user-owned tracking on a Today follow-up: when they intend to do it and
-- who they will do it with. Operational overlay state, never canonical, never an
-- external action (no calendar/email). Stored on the existing companion_state row.
alter table public.companion_state add column if not exists due_date timestamptz;
alter table public.companion_state add column if not exists linked_person_id uuid;
