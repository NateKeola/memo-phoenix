-- PR (revised companion): the companion is a conversational follow-up assistant,
-- not an email/calendar sender. The Gmail/Calendar sending layer (and its tokens
-- and send audit) is deferred to a later settings/connectors build, so drop the
-- two tables it introduced. companion_state (the done/snooze/dismiss overlay) stays.
drop table if exists public.companion_actions;
drop table if exists public.google_connections;

-- Label-drift resilience for the overlay. companion_state is keyed on the
-- deterministic commitment id (uuidv5 over the normalized label), so if a
-- commitment's label drifts on a later mine its id changes and the overlay would
-- orphan (a done item could reappear). Store a stable signature at write time
-- (the label and the linked person) so the surface can re-match the overlay to a
-- re-resolved commitment whose id changed. This is a LOCAL fix on the overlay; the
-- root-cause identity hardening across the miner is a separate dedicated PR.
alter table public.companion_state add column if not exists match_label text;
alter table public.companion_state add column if not exists match_person_id uuid;
