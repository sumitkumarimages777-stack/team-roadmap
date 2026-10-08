-- =====================================================================
-- STAGE 8a — Social Media targets: their own section + "Edit social targets"
--
-- WHAT THIS DOES, in plain words:
--   * Adds a new permission, edit_targets ("Edit social targets"), that an
--     owner can tick on any role in Administration -> Roles & permissions.
--     Owners always have it.
--   * The targets of every Social Media space are saved in their own piece of
--     team data ("socialTargets"). Only people whose role has edit_targets can
--     save that piece; everyone in the team can still read it.
--
-- WHAT THIS DOES NOT DO: it deletes nothing. Existing roles keep exactly the
-- permissions they have; nobody but owners gets edit_targets until it's ticked.
-- =====================================================================

create or replace function public.all_perms() returns text[]
language sql immutable set search_path = '' as $$
  select array['view','comment','edit','delete','spaces','okr_structure','module_vision',
               'request_members','approve_requests','manage_people','create_games','edit_targets']
$$;

update public.team_roles set perms = public.all_perms() where key = 'owner';

create or replace function public.can_write_section(team text, sec text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when sec in ('kim', 'teamIdeas') then public.has_role(team, 'viewer')
    when sec = 'socialTargets' then public.has_perm(team, 'edit_targets')
    else public.has_perm(team, 'edit') or public.has_perm(team, 'comment') or public.has_perm(team, 'delete')
      or public.has_perm(team, 'spaces') or public.has_perm(team, 'okr_structure') or public.has_perm(team, 'module_vision')
  end
$$;
