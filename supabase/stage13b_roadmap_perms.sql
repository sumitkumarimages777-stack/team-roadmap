-- =====================================================================
-- STAGE 13b — who may create and delete roadmaps
--
-- WHAT THIS DOES, in plain words:
--   * Two new permissions an owner can tick in Roles & permissions:
--       add_roadmaps     "Create roadmaps" — ＋ New roadmap, now only in
--                                            Administration → Roadmaps
--       delete_roadmaps  "Delete roadmaps" — "Delete roadmap" in its ⋯ menu
--   * Owners always have both; nobody else does until it's ticked.
--
-- SAFETY: only adds two names to the permission list. Deletes nothing.
-- =====================================================================

create or replace function public.all_perms() returns text[]
language sql immutable set search_path = '' as $$
  select array['view','comment','edit','delete','spaces','okr_structure','module_vision',
               'request_members','approve_requests','manage_people','create_games','edit_targets','edit_utm',
               'send_notifications','manage_learning','add_spaces','delete_spaces','add_roadmaps','delete_roadmaps']
$$;

update public.team_roles set perms = public.all_perms() where key = 'owner';
