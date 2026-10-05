-- =====================================================================
-- STAGE 6a — Games library (team-made games, review, Let's Play path)
--
-- WHAT THIS DOES, in plain words:
--   * A new permission, "create_games", for the Roles page.
--   * Each person's membership in a team gets a department (set by people
--     with "Manage people"), so Department-level games reach the right people.
--   * games          one row per game: name, emoji, tagline, level
--                    (company / department / team), creator, status
--                    (draft / submitted / approved / sent_back), versions.
--                    The game FILES are kept in a private storage folder
--                    ("games"), max 3 MB each — never in the app's code.
--   * game_progress  who finished which game (the badges).
--   * game_path      the 10 slots of Let's Play, chosen by the super-admin.
--   * Jadugar and 1% become library games, and everyone's existing badges
--     for them are copied over.
--
-- Who can see what (enforced by the database):
--   - a game's creator always sees their own games (any status);
--   - the super-admin sees everything;
--   - everyone else sees only APPROVED, not-retired games for their level:
--       company    -> anyone in any team
--       team       -> members of that team
--       department -> members of that team in that department.
--   Saving, submitting and reviewing go through the manage-games server
--   function; the browser can't change games directly.
--
-- SAFETY: creates new tables, a column and a storage folder; changes the
-- permission list. Deletes nothing. Copies badges; doesn't remove old ones.
-- HOW TO RUN: SQL Editor -> New query -> paste -> Run.
-- Expected: "Success. No rows returned".
-- =====================================================================

begin;

-- ---------- 1. the new permission -----------------------------------------
create or replace function public.all_perms() returns text[]
language sql immutable set search_path = '' as $$
  select array['view','comment','edit','delete','spaces','okr_structure','module_vision',
               'request_members','approve_requests','manage_people','create_games']
$$;
-- Owners have every permission
update public.team_roles set perms = public.all_perms() where key = 'owner';

-- ---------- 2. departments ------------------------------------------------
alter table public.memberships add column if not exists department text;

create function public.set_member_department(p_team text, p_user uuid, p_dept text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_perm(p_team, 'manage_people') then raise exception 'You don''t have permission to manage people in this team.'; end if;
  update public.memberships set department = nullif(trim(coalesce(p_dept, '')), '')
   where team_slug = p_team and user_id = p_user;
  if not found then raise exception 'That person isn''t in this team.'; end if;
end $$;

-- ---------- 3. games ------------------------------------------------------
create table public.games (
  id             uuid primary key default gen_random_uuid(),
  title          text not null check (length(trim(title)) between 1 and 80),
  emoji          text not null default '🎮',
  tagline        text not null default '',          -- one line, e.g. "You know less than 1%."
  takeaway       text not null default '',          -- the lesson shown with the badge
  level          text not null default 'company' check (level in ('company','team','department')),
  team_slug      text references public.teams(slug) on delete cascade on update cascade,
  department_id  text,                               -- for department-level games
  kind           text not null default 'html' check (kind in ('html','builtin')),
  builtin_key    text unique,                        -- 'jadugar', 'one-percent' (kind = builtin)
  status         text not null default 'draft' check (status in ('draft','submitted','approved','sent_back')),
  version        int  not null default 1,            -- latest uploaded version
  live_version   int,                                -- the approved version people play (null = not live)
  file_size      int,
  retired        boolean not null default false,
  creator        uuid references auth.users(id) on delete set null,
  review_note    text,
  reviewed_by    uuid references auth.users(id) on delete set null,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (level <> 'department' or (team_slug is not null and department_id is not null)),
  check (level <> 'team' or team_slug is not null)
);
create index games_status_idx on public.games(status);
create index games_creator_idx on public.games(creator);

-- can the signed-in person PLAY this game? (approved, live, not retired, right level)
create function public.can_play_game(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.games g
    where g.id = p_id and g.live_version is not null and not g.retired and (
      public.is_super()
      or (g.level = 'company'    and exists (select 1 from public.memberships m where m.user_id = auth.uid()))
      or (g.level = 'team'       and public.has_role(g.team_slug, 'viewer'))
      or (g.level = 'department' and exists (select 1 from public.memberships m
                                             where m.user_id = auth.uid() and m.team_slug = g.team_slug
                                               and m.department = g.department_id))
    ))
$$;

create table public.game_progress (
  user_id       uuid not null references auth.users(id) on delete cascade,
  game_id       uuid not null references public.games(id) on delete cascade,
  completed_at  timestamptz not null default now(),
  primary key (user_id, game_id)
);

create table public.game_path (
  slot     int primary key check (slot between 1 and 10),
  game_id  uuid references public.games(id) on delete set null
);

-- ---------- 4. who can see / change what -----------------------------------
alter table public.games         enable row level security;
alter table public.game_progress enable row level security;
alter table public.game_path     enable row level security;
revoke all on public.games, public.game_progress, public.game_path from anon;
revoke insert, update, delete, truncate on public.games, public.game_path from authenticated;
revoke update, delete, truncate on public.game_progress from authenticated;
grant select on public.games, public.game_path to authenticated;
grant select, insert on public.game_progress to authenticated;

create policy "see your own games, playable games, or all if super" on public.games
  for select to authenticated
  using (creator = auth.uid() or public.is_super() or public.can_play_game(id));

create policy "everyone signed in sees the path" on public.game_path
  for select to authenticated using (true);

create policy "see your own badges" on public.game_progress
  for select to authenticated using (user_id = auth.uid());
create policy "earn a badge for a game you can play" on public.game_progress
  for insert to authenticated
  with check (user_id = auth.uid() and public.can_play_game(game_id));

-- ---------- 5. the private folder for game files (3 MB each) ----------------
-- No access rules are added for it: only the manage-games server function
-- (which checks permissions first) can read or write these files.
insert into storage.buckets (id, name, public, file_size_limit)
values ('games', 'games', false, 3145728)
on conflict (id) do nothing;

-- ---------- 6. Jadugar and 1% join the library -----------------------------
insert into public.games (id, title, emoji, tagline, level, kind, builtin_key, status, version, live_version)
values ('00000000-0000-4000-8000-00000000000a', 'Jadugar', '🔮', 'We are jadugars.',       'company', 'builtin', 'jadugar',     'approved', 1, 1),
       ('00000000-0000-4000-8000-00000000000b', '1%',      '🔎', 'You know less than 1%.', 'company', 'builtin', 'one-percent', 'approved', 1, 1)
on conflict (id) do nothing;

insert into public.game_path (slot, game_id) values
  (1, '00000000-0000-4000-8000-00000000000a'),
  (2, '00000000-0000-4000-8000-00000000000b')
on conflict (slot) do nothing;

-- everyone's existing badges (stored per email in each team's "kim" section)
insert into public.game_progress (user_id, game_id)
select distinct p.id, g.id
from public.team_data t
cross join lateral jsonb_each(coalesce(t.data -> 'byUser', '{}'::jsonb)) as u(email, done)
join public.profiles p on p.email = lower(u.email)
join public.games g on (g.builtin_key = 'jadugar' and (u.done ? '1')) or (g.builtin_key = 'one-percent' and (u.done ? '2'))
where t.section = 'kim' and jsonb_typeof(u.done) = 'object'
on conflict do nothing;

-- ---------- 7. function permissions ----------------------------------------
revoke execute on function public.can_play_game(uuid), public.set_member_department(text, uuid, text) from public, anon;
grant execute on function public.can_play_game(uuid), public.set_member_department(text, uuid, text) to authenticated;

commit;
