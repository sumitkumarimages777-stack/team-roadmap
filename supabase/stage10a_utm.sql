-- =====================================================================
-- STAGE 10a — UTM builder in the Wiki (Marketing)
--
-- WHAT THIS DOES, in plain words:
--   * Adds a new permission, edit_utm ("Edit UTM rules"), that an owner can
--     tick on any role in Administration -> Roles & permissions. Owners always
--     have it.
--   * The UTM rules (allowed sources, mediums, campaign format) are saved in
--     their own piece of team data ("utmRules"). Only roles with edit_utm can
--     save it; everyone in the team can read it.
--   * The UTM links people make are saved in "utmLinks"; any team member can
--     add to it (so everyone can build links that follow the rules).
--
-- WHAT THIS DOES NOT DO: it deletes nothing. Existing roles keep exactly the
-- permissions they have; nobody but owners gets edit_utm until it's ticked.
-- =====================================================================

create or replace function public.all_perms() returns text[]
language sql immutable set search_path = '' as $$
  select array['view','comment','edit','delete','spaces','okr_structure','module_vision',
               'request_members','approve_requests','manage_people','create_games','edit_targets','edit_utm']
$$;

update public.team_roles set perms = public.all_perms() where key = 'owner';

create or replace function public.can_write_section(team text, sec text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when sec in ('kim', 'teamIdeas', 'utmLinks') then public.has_role(team, 'viewer')
    when sec = 'socialTargets' then public.has_perm(team, 'edit_targets')
    when sec = 'utmRules' then public.has_perm(team, 'edit_utm')
    else public.has_perm(team, 'edit') or public.has_perm(team, 'comment') or public.has_perm(team, 'delete')
      or public.has_perm(team, 'spaces') or public.has_perm(team, 'okr_structure') or public.has_perm(team, 'module_vision')
  end
$$;
