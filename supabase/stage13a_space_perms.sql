-- =====================================================================
-- STAGE 13a — who may add and delete spaces
--
-- WHAT THIS DOES, in plain words:
--   * Two new permissions an owner can tick in Roles & permissions:
--       add_spaces     "Add spaces"    — the ＋ Add space button, now only in
--                                        Administration → Spaces
--       delete_spaces  "Delete spaces" — "Delete…" in a space's ⋯ menu
--   * Owners always have both; nobody else does until it's ticked.
--   * The old "spaces" permission stays in the list but the app no longer
--     uses it for adding or deleting spaces.
--
-- SAFETY: only adds two names to the permission list. Deletes nothing.
-- =====================================================================

create or replace function public.all_perms() returns text[]
language sql immutable set search_path = '' as $$
  select array['view','comment','edit','delete','spaces','okr_structure','module_vision',
               'request_members','approve_requests','manage_people','create_games','edit_targets','edit_utm',
               'send_notifications','manage_learning','add_spaces','delete_spaces']
$$;

update public.team_roles set perms = public.all_perms() where key = 'owner';
