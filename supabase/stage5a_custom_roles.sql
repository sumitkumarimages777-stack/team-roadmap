-- =====================================================================
-- STAGE 5a — Custom roles per team
--
-- WHAT THIS DOES, in plain words:
--   * Each team gets its own list of roles (e.g. Owner, Admin, Manager,
--     Team mate). Each role is a set of ticked permissions:
--       view             see the team's spaces, boards, roadmap (always on)
--       comment          add comments
--       edit             create & edit work
--       delete           delete work (cards, items...)
--       spaces           add & remove spaces
--       okr_structure    restructure OKRs (per-objective access stays as is)
--       module_vision    edit "What we're building" on modules
--       request_members  request new teammates (sent for approval)
--       approve_requests approve / reject those requests
--       manage_people    add people directly, change roles, edit, email, remove
--   * "Owner" is built in, always has every permission and can't be edited,
--     so nobody can be locked out. Only Owners (and the super-admin) can
--     create or change a team's roles.
--   * Fixed to the super-admin only: company Vision, creating/deleting
--     teams, deleting a person permanently.
--   * Today's people move over without losing anything:
--       owner  -> Owner
--       admin  -> "Admin"     (every permission)
--       editor / commenter / viewer -> "Team mate"
--                             (view, comment, edit, delete, spaces)
--
-- SAFETY: creates one table and replaces some rule functions. The only
-- removal is the old fixed list of 5 role names on the memberships table
-- (it would block custom roles). No people or data are deleted.
--
-- HOW TO RUN: SQL Editor -> New query -> paste -> Run.
-- Expected: "Success. No rows returned".
-- =====================================================================

begin;

-- ---------- 1. the roles table ----------------------------------------
create table public.team_roles (
  team_slug   text not null references public.teams(slug) on delete cascade on update cascade,
  key         text not null check (key ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name        text not null,
  position    int  not null default 100,
  perms       text[] not null default '{view}',
  created_at  timestamptz not null default now(),
  primary key (team_slug, key)
);

-- the permission names the app understands
create function public.all_perms() returns text[]
language sql immutable set search_path = '' as $$
  select array['view','comment','edit','delete','spaces','okr_structure','module_vision',
               'request_members','approve_requests','manage_people']
$$;

-- ---------- 2. starting roles for every existing team -------------------
insert into public.team_roles (team_slug, key, name, position, perms)
select t.slug, r.key, r.name, r.position, r.perms
from public.teams t
cross join (values
  ('owner',     'Owner',     0,  public.all_perms()),
  ('admin',     'Admin',     10, public.all_perms()),
  ('team-mate', 'Team mate', 50, array['view','comment','edit','delete','spaces'])
) as r(key, name, position, perms);

-- ---------- 3. move today's people onto the new roles --------------------
alter table public.memberships drop constraint if exists memberships_role_check;
update public.memberships set role = 'team-mate' where role in ('editor','commenter','viewer');
alter table public.memberships
  add constraint memberships_role_fk foreign key (team_slug, role)
  references public.team_roles (team_slug, key) on update cascade;   -- a role in use can't be deleted

-- ---------- 4. permission checks ------------------------------------------
-- "does the signed-in person have this permission in this team?"
create function public.has_perm(team text, perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when auth.uid() is null then false
    when public.is_super() then true
    else coalesce((
      select m.role = 'owner' or perm = any(r.perms)
      from public.memberships m
      join public.team_roles r on r.team_slug = m.team_slug and r.key = m.role
      where m.team_slug = team and m.user_id = auth.uid()), false)
  end
$$;

-- The rules written for the old fixed roles keep working: each old name now
-- means the matching permission.
create or replace function public.has_role(team text, min_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case min_role
    when 'owner'     then public.my_role(team) = 'owner'
    when 'admin'     then public.has_perm(team, 'manage_people')
    when 'editor'    then public.has_perm(team, 'edit')
    when 'commenter' then public.has_perm(team, 'comment') or public.has_perm(team, 'edit')
    else public.my_role(team) <> ''          -- 'viewer': any member of the team
  end
$$;

-- Team content: game progress and idea votes = any member; everything else
-- needs a permission that changes content (comments are stored inside it).
create or replace function public.can_write_section(team text, sec text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when sec in ('kim', 'teamIdeas') then public.has_role(team, 'viewer')
    else public.has_perm(team, 'edit') or public.has_perm(team, 'comment') or public.has_perm(team, 'delete')
      or public.has_perm(team, 'spaces') or public.has_perm(team, 'okr_structure') or public.has_perm(team, 'module_vision')
  end
$$;

-- ---------- 5. changing someone's role -----------------------------------
create or replace function public.set_member_role(p_team text, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
begin
  if not public.has_perm(p_team, 'manage_people') then raise exception 'You don''t have permission to manage people in this team.'; end if;
  if not exists (select 1 from public.team_roles r where r.team_slug = p_team and r.key = p_role) then
    raise exception 'Unknown role: %', p_role;
  end if;
  if p_role = 'owner' and not public.is_super() then raise exception 'Only a super-admin can make someone an Owner.'; end if;
  select m.role into v_role from public.memberships m where m.team_slug = p_team and m.user_id = p_user;
  if v_role = 'owner' and not public.is_super() then raise exception 'Only a super-admin can change an Owner.'; end if;
  insert into public.memberships(team_slug, user_id, role) values (p_team, p_user, p_role)
    on conflict (team_slug, user_id) do update set role = excluded.role;
end $$;

-- ---------- 6. managing a team's roles (Owners and the super-admin) -------
create function public.save_team_role(p_team text, p_key text, p_name text, p_perms text[], p_position int)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_perms text[];
begin
  if public.my_role(p_team) <> 'owner' then raise exception 'Only an Owner can change this team''s roles.'; end if;
  if p_key = 'owner' then raise exception 'The Owner role is built in and can''t be changed.'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the role a name.'; end if;
  if exists (select 1 from unnest(coalesce(p_perms, '{}')) x where x <> all (public.all_perms())) then
    raise exception 'Unknown permission.';
  end if;
  -- "view" is always included, and no duplicates
  select array(select distinct x from unnest(array['view'] || coalesce(p_perms, '{}')) x order by 1) into v_perms;
  insert into public.team_roles (team_slug, key, name, position, perms)
  values (p_team, p_key, trim(p_name), coalesce(p_position, 100), v_perms)
  on conflict (team_slug, key) do update
    set name = excluded.name, position = excluded.position, perms = excluded.perms;
end $$;

create function public.delete_team_role(p_team text, p_key text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.my_role(p_team) <> 'owner' then raise exception 'Only an Owner can change this team''s roles.'; end if;
  if p_key = 'owner' then raise exception 'The Owner role is built in and can''t be deleted.'; end if;
  if exists (select 1 from public.memberships m where m.team_slug = p_team and m.role = p_key) then
    raise exception 'Some people still have this role. Give them another role first.';
  end if;
  delete from public.team_roles where team_slug = p_team and key = p_key;
end $$;

-- ---------- 7. new teams start with the same three roles -----------------
create or replace function public.create_team(p_slug text, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_super() then raise exception 'Only a super-admin can create teams.'; end if;
  insert into public.teams(slug, name, created_by) values (p_slug, p_name, auth.uid());
  insert into public.team_roles (team_slug, key, name, position, perms) values
    (p_slug, 'owner',     'Owner',     0,  public.all_perms()),
    (p_slug, 'admin',     'Admin',     10, public.all_perms()),
    (p_slug, 'team-mate', 'Team mate', 50, array['view','comment','edit','delete','spaces']);
end $$;

-- ---------- 8. who can see a team's roles --------------------------------
alter table public.team_roles enable row level security;
revoke all on public.team_roles from anon;
revoke insert, update, delete, truncate on public.team_roles from authenticated;
grant select on public.team_roles to authenticated;
create policy "members see their team's roles" on public.team_roles
  for select to authenticated using (public.has_role(team_slug, 'viewer'));

revoke execute on function public.all_perms(), public.has_perm(text, text),
  public.save_team_role(text, text, text, text[], int), public.delete_team_role(text, text)
  from public, anon;
grant execute on function public.all_perms(), public.has_perm(text, text),
  public.save_team_role(text, text, text, text[], int), public.delete_team_role(text, text)
  to authenticated;

commit;
