-- =====================================================================
-- STAGE 9a — Where the audience is (state / city / country)
--
-- WHAT THIS DOES, in plain words:
--   * One new table, social_geo, that the "sync-social" Edge Function fills
--     every day with where viewers and followers/subscribers are:
--       YouTube   viewers by city (India, last 90 days) and views +
--                 new subscribers by country (YouTube shares subscribers
--                 by country only).
--       Instagram followers and reached accounts by city ("City, State")
--                 and by country (Meta shares the top cities only).
--   * Team members can read it; only the Edge Function writes it.
--
-- WHAT THIS DOES NOT DO: it deletes nothing and changes nothing that exists.
-- =====================================================================

create table if not exists public.social_geo (
  team_slug  text not null references public.teams(slug) on delete cascade on update cascade,
  platform   text not null check (platform in ('youtube', 'instagram')),
  kind       text not null check (kind in ('viewers', 'followers', 'subscribers')),
  level      text not null check (level in ('city', 'country', 'total')),
  name       text not null,          -- city, or 2-letter country code, or 'IN' for the India total
  state      text,                   -- Indian state for a city ('' when unknown)
  value      numeric,
  period     text,                   -- e.g. 'last 90 days', 'all time', 'this month'
  updated_at timestamptz not null default now(),
  primary key (team_slug, platform, kind, level, name)
);
alter table public.social_geo enable row level security;
revoke all on public.social_geo from anon, authenticated;
grant select on public.social_geo to authenticated;
create policy "members read social geo" on public.social_geo
  for select to authenticated using (public.has_role(team_slug, 'viewer'));
