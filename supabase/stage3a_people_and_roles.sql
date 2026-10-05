-- =====================================================================
-- STAGE 3a — People, teams and roles (Cyberflow team app)
--
-- WHAT THIS DOES, in plain words:
--   * Creates three tables:  teams, profiles (one per person), memberships
--     (who is in which team, with which role).
--   * Turns on Row Level Security: the database itself decides who can see
--     or change each row, using the same role ladder the app already has:
--         owner > admin > editor > commenter > viewer
--   * Adds a few "safe buttons" (functions) the app calls to change roles,
--     so the role rules live in ONE place, here, and can't be skipped.
--
-- WHAT THIS DOES NOT DO:
--   * It deletes nothing and changes no existing data. The project is empty;
--     this only creates new things. There is no DROP, DELETE or TRUNCATE
--     anywhere in this file.
--   * The live app keeps using JSONBin until a later step switches it over.
--
-- HOW TO RUN: Supabase dashboard -> SQL Editor -> New query -> paste all of
-- this -> Run. You should see "Success. No rows returned".
-- =====================================================================


-- ---------- 1. Tables ------------------------------------------------

-- A team, e.g. slug "dubuddy" (that's the ?team=dubuddy in the URL).
create table public.teams (
  slug        text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  name        text not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) on delete set null
);

-- One row per person. The login itself (email + password) lives in
-- Supabase Auth; this holds the extra things the app shows.
create table public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text not null unique,
  name            text not null default '',
  username        text unique,                       -- optional, lowercase
  is_super        boolean not null default false,    -- super-admin: owner of every team
  must_change_pw  boolean not null default false,    -- forced to pick a new password on next login
  profile         jsonb not null default '{}'::jsonb, -- photo, title, dept, bio... (all optional)
  created_at      timestamptz not null default now()
);

-- Who is in which team, and as what.
create table public.memberships (
  team_slug  text not null references public.teams(slug) on delete cascade on update cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null check (role in ('owner','admin','editor','commenter','viewer')),
  added_at   timestamptz not null default now(),
  primary key (team_slug, user_id)
);
create index memberships_user_idx on public.memberships(user_id);


-- ---------- 2. Helpers: "what role do I have in this team?" ----------
-- auth.uid() = the person who is signed in, as proven by Supabase Auth.
-- It cannot be faked from the browser the way the old session string could.

-- owner=0, admin=1, editor=2, commenter=3, viewer=4, anything else=99
create function public.role_rank(r text) returns int
language sql immutable set search_path = '' as $$
  select coalesce(array_position(array['owner','admin','editor','commenter','viewer'], r) - 1, 99)
$$;

create function public.is_super() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.is_super from public.profiles p where p.id = auth.uid()), false)
$$;

-- my role in a team ('' if I'm not in it). Super-admin is owner everywhere.
create function public.my_role(team text) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when auth.uid() is null then ''
    when public.is_super() then 'owner'
    else coalesce((select m.role from public.memberships m
                   where m.team_slug = team and m.user_id = auth.uid()), '')
  end
$$;

-- "do I have at least `min_role` in this team?"  — same as can() in index.html
create function public.has_role(team text, min_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.my_role(team) <> ''
     and public.role_rank(public.my_role(team)) <= public.role_rank(min_role)
$$;

-- "do I share at least one team with this person?"
create function public.shares_team(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships a
    join public.memberships b on a.team_slug = b.team_slug
    where a.user_id = auth.uid() and b.user_id = other)
$$;


-- ---------- 3. Row Level Security: who can see / change what ---------

alter table public.teams       enable row level security;
alter table public.profiles    enable row level security;
alter table public.memberships enable row level security;

-- Signed-out visitors get nothing at all from these tables.
revoke all on public.teams, public.profiles, public.memberships from anon;

-- Signed-in people may only READ directly. Every change goes through the
-- functions in section 4 (or, for your own profile, the columns allowed below).
revoke insert, update, delete, truncate on public.teams, public.profiles, public.memberships from authenticated;

-- TEAMS: you see the teams you belong to (super-admin sees all).
create policy "members see their teams" on public.teams
  for select to authenticated using (public.has_role(slug, 'viewer'));

-- PROFILES: you see yourself, people you share a team with, or everyone if super.
create policy "see yourself and teammates" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_super() or public.shares_team(id));

-- You can edit your OWN name, username, profile details and the
-- "must change password" flag — never is_super or email.
grant update (name, username, profile, must_change_pw) on public.profiles to authenticated;
create policy "edit your own profile" on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- MEMBERSHIPS: you see your own memberships, and the member list of any team you're in.
create policy "see members of your teams" on public.memberships
  for select to authenticated
  using (user_id = auth.uid() or public.has_role(team_slug, 'viewer'));


-- ---------- 4. Safe buttons (the only way to change teams & roles) ---
-- These run with extra power, so each one checks the caller's role first.
-- The rules are copied from index.html:
--   * only the super-admin creates or deletes teams
--   * Owners and Admins manage people
--   * only the super-admin can make someone an Owner
--   * only the super-admin can change or remove an Owner
--   * you can't remove yourself

create function public.create_team(p_slug text, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_super() then raise exception 'Only a super-admin can create teams.'; end if;
  insert into public.teams(slug, name, created_by) values (p_slug, p_name, auth.uid());
end $$;

create function public.rename_team(p_slug text, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_role(p_slug, 'admin') then raise exception 'Only Owners and Admins can rename a team.'; end if;
  update public.teams set name = p_name where slug = p_slug;
end $$;

create function public.delete_team(p_slug text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_super() then raise exception 'Only a super-admin can delete a team.'; end if;
  if (select count(*) from public.teams) <= 1 then raise exception 'This is your only team — create another one first.'; end if;
  delete from public.teams where slug = p_slug;   -- its memberships go with it
end $$;

-- Add someone who already has an account to a team, or change their role.
create function public.set_member_role(p_team text, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
begin
  if not public.has_role(p_team, 'admin') then raise exception 'Only Owners and Admins can manage people.'; end if;
  if public.role_rank(p_role) = 99 then raise exception 'Unknown role: %', p_role; end if;
  if p_role = 'owner' and not public.is_super() then raise exception 'Only a super-admin can make someone an Owner.'; end if;
  select m.role into v_role from public.memberships m where m.team_slug = p_team and m.user_id = p_user;
  if v_role = 'owner' and not public.is_super() then raise exception 'Only a super-admin can change an Owner.'; end if;
  insert into public.memberships(team_slug, user_id, role) values (p_team, p_user, p_role)
    on conflict (team_slug, user_id) do update set role = excluded.role;
end $$;

create function public.remove_member(p_team text, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_role(p_team, 'admin') then raise exception 'Only Owners and Admins can manage people.'; end if;
  if p_user = auth.uid() then raise exception 'You can''t remove yourself.'; end if;
  if (select m.role from public.memberships m where m.team_slug = p_team and m.user_id = p_user) = 'owner'
     and not public.is_super() then raise exception 'Only a super-admin can remove an Owner.'; end if;
  delete from public.memberships where team_slug = p_team and user_id = p_user;
end $$;

-- The login box accepts an email OR a username. Supabase logs in by email,
-- so this turns a username into its email. Returns nothing if not found.
create function public.email_for_login(p_login text) returns text
language sql stable security definer set search_path = '' as $$
  select p.email from public.profiles p
  where p.email = lower(trim(p_login)) or p.username = lower(trim(p_login))
  limit 1
$$;

-- Who may press which button. Functions are callable by everyone by default,
-- so first take that away, then hand each one to the right group.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.role_rank(text), public.is_super(), public.my_role(text),
                          public.has_role(text, text), public.shares_team(uuid),
                          public.create_team(text, text), public.rename_team(text, text),
                          public.delete_team(text), public.set_member_role(text, uuid, text),
                          public.remove_member(text, uuid)
  to authenticated;
grant execute on function public.email_for_login(text) to anon, authenticated;
