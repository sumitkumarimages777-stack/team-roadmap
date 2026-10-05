-- =====================================================================
-- STAGE 4a — Team data (roadmap, OKRs, content, boards, docs, games...)
--
-- WHAT THIS DOES, in plain words:
--   * Creates ONE new table, team_data. Each team's data is stored as a
--     few separate pieces ("sections"): roadmap, okrs, content, dev, docs,
--     orgChart, kim (the games) and so on — the same pieces the app already
--     saves today, so nothing is reshaped.
--   * Security rules, enforced by the database itself:
--       - You only ever see data of teams you belong to (super-admin: all).
--       - Viewers can read everything, and save only their own game
--         progress (kim) and idea votes (teamIdeas).
--       - Commenters and above can save the other sections (comments are
--         stored inside them, so commenters need this to comment).
--       - Signed-out visitors get nothing.
--       - Nobody can delete data from the browser; it only goes away when
--         the super-admin deletes a whole team.
--
-- WHAT THIS DOES NOT DO: it deletes nothing and changes nothing that
-- exists. There is no DROP, DELETE or TRUNCATE in this file.
--
-- HOW TO RUN: SQL Editor -> New query -> paste -> Run.
-- Expected: "Success. No rows returned".
-- =====================================================================

create table public.team_data (
  team_slug   text not null references public.teams(slug) on delete cascade on update cascade,
  section     text not null check (section ~ '^[A-Za-z][A-Za-z0-9_]{0,40}$'),
  data        jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid(),
  primary key (team_slug, section)
);

-- keep "who saved last, and when" up to date on every change
create function public.team_data_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger team_data_touch before insert or update on public.team_data
  for each row execute function public.team_data_touch();

-- which role may SAVE a given section
create function public.can_write_section(team text, sec text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when sec in ('kim', 'teamIdeas') then public.has_role(team, 'viewer')
    else public.has_role(team, 'commenter')
  end
$$;

alter table public.team_data enable row level security;
revoke all on public.team_data from anon;
revoke delete, truncate on public.team_data from authenticated;
grant select, insert, update on public.team_data to authenticated;

create policy "members read their team's data" on public.team_data
  for select to authenticated using (public.has_role(team_slug, 'viewer'));

create policy "allowed roles add sections" on public.team_data
  for insert to authenticated with check (public.can_write_section(team_slug, section));

create policy "allowed roles save sections" on public.team_data
  for update to authenticated
  using (public.can_write_section(team_slug, section))
  with check (public.can_write_section(team_slug, section));

revoke execute on function public.can_write_section(text, text) from public, anon;
grant execute on function public.can_write_section(text, text) to authenticated;
revoke execute on function public.team_data_touch() from public, anon, authenticated;
