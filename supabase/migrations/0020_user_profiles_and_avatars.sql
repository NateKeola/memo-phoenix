-- 0020: user profile (display name + avatar) and a private per-user avatar bucket.
--
-- User-owned profile metadata, NEVER canonical (the miner owns canonical; invariant
-- 4). A per-user row + a private Storage bucket, both scoped by RLS so a user can only
-- ever read or write their OWN profile and their OWN image.

-- Profile row: display name + a pointer to the avatar object in Storage. Mutable
-- overlay written by the user's RLS client, like companion_state / event_tags.
create table public.user_profiles (
  user_id      uuid primary key,                 -- auth.users.id (one row per user)
  display_name text,
  avatar_path  text,                             -- object name in the 'avatars' bucket, null = no photo
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

alter table public.user_profiles enable row level security;
alter table public.user_profiles force row level security;
create policy user_profiles_sel on public.user_profiles
  for select to authenticated using (user_id = auth.uid());
create policy user_profiles_ins on public.user_profiles
  for insert to authenticated with check (user_id = auth.uid());
create policy user_profiles_upd on public.user_profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy user_profiles_del on public.user_profiles
  for delete to authenticated using (user_id = auth.uid());

-- Private avatar bucket. NOT public (no anonymous URL): images are served only via
-- short-lived signed URLs generated for the owning user. Bucket-level size + mime
-- limits are defense in depth beyond the server action's own checks.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 5242880, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do nothing;

-- Per-user isolation on the objects: the first path segment must be the user's id,
-- so a user can only read/write/delete objects under avatars/<their-uid>/... and can
-- never see another user's photo. storage.objects already has RLS enabled.
create policy avatars_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy avatars_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy avatars_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy avatars_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
