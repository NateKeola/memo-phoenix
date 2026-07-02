-- 0016: capture exclusions, the retraction path append-only tables permit.
--
-- captures and raw_* are hard append-only (forbid_mutation), so a bad capture (a
-- double-submitted duplicate, a mis-paste) can never be deleted or edited. This
-- table is the soft retraction: an exclusion row marks a capture's content as
-- inadmissible, and the miner honors it at READ time (extraction skips excluded
-- captures; derivation filters out their raw claims; a full recompute then retires
-- canonical rows whose only evidence was excluded). Nothing is ever hard-deleted:
-- the capture, its raw rows, and canonical history all remain, so provenance and
-- auditability are preserved and an exclusion is reversible (delete the row and
-- the next full recompute folds the capture back in).
--
-- Operational state, not ground truth: mutable by the owner (insert to exclude,
-- delete to undo), like companion_state. The miner (service role) only reads it.

create table public.capture_exclusions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  capture_id uuid not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (user_id, capture_id)
);

alter table public.capture_exclusions enable row level security;
alter table public.capture_exclusions force row level security;

create policy capture_exclusions_sel on public.capture_exclusions
  for select to authenticated using (user_id = auth.uid());
create policy capture_exclusions_ins on public.capture_exclusions
  for insert to authenticated with check (user_id = auth.uid());
create policy capture_exclusions_del on public.capture_exclusions
  for delete to authenticated using (user_id = auth.uid());
