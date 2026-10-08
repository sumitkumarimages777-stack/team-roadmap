-- =====================================================================
-- STAGE 7a — Social media numbers, filled automatically (YouTube first)
--
-- WHAT THIS DOES, in plain words:
--   * Creates two new tables that the "sync-social" Edge Function fills:
--       social_snapshots  one row per platform per day: follower count
--                         (feeds "Followers", "+N this week" and the
--                         weekly growth charts).
--       social_posts      one row per published video/post with its
--                         numbers: views, likes, comments, shares, watch
--                         time, thumbnail CTR.
--   * Security: team members can READ these numbers. Nobody can write them
--     from the browser; only the Edge Function (server key) writes.
--   * A private settings row holding the key the daily timer uses to call
--     the Edge Function. Not readable from the browser.
--   * Turns on pg_cron + pg_net and schedules the sync once a day.
--
-- WHAT THIS DOES NOT DO: it deletes nothing and changes nothing that
-- exists. There is no DROP, DELETE or TRUNCATE in this file.
-- =====================================================================

create table public.social_snapshots (
  team_slug   text not null references public.teams(slug) on delete cascade on update cascade,
  platform    text not null check (platform in ('youtube', 'instagram')),
  day         date not null,
  followers   bigint,
  total_views bigint,
  post_count  integer,
  updated_at  timestamptz not null default now(),
  primary key (team_slug, platform, day)
);

create table public.social_posts (
  team_slug     text not null references public.teams(slug) on delete cascade on update cascade,
  platform      text not null check (platform in ('youtube', 'instagram')),
  external_id   text not null,
  title         text,
  url           text,
  thumbnail     text,
  post_type     text,            -- 'Short' | 'Long video' | 'Live' | 'Reel' | 'Carousel' | 'Image'
  published_at  timestamptz,
  duration_s    integer,
  views         bigint,
  likes         bigint,
  comments      bigint,
  shares        bigint,
  watch_minutes numeric,
  avg_view_s    numeric,         -- average view duration, seconds
  avg_view_pct  numeric,
  impressions   bigint,
  ctr_pct       numeric,
  updated_at    timestamptz not null default now(),
  primary key (team_slug, platform, external_id)
);

create table public.social_sync_config (
  id         integer primary key check (id = 1),
  team_slug  text not null references public.teams(slug) on delete cascade on update cascade,
  cron_key   text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  last_sync  timestamptz,
  last_result jsonb
);
insert into public.social_sync_config (id, team_slug) values (1, 'dubuddy');

alter table public.social_snapshots   enable row level security;
alter table public.social_posts       enable row level security;
alter table public.social_sync_config enable row level security;   -- no policies: server only

revoke all on public.social_snapshots, public.social_posts, public.social_sync_config from anon, authenticated;
grant select on public.social_snapshots, public.social_posts to authenticated;

create policy "members read social snapshots" on public.social_snapshots
  for select to authenticated using (public.has_role(team_slug, 'viewer'));
create policy "members read social posts" on public.social_posts
  for select to authenticated using (public.has_role(team_slug, 'viewer'));

-- daily timer: 02:30 UTC (08:00 IST), after YouTube has published yesterday's numbers
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'sync-social-daily',
  '30 2 * * *',
  $$ select net.http_post(
       url     := 'https://bzhnzrmnbphkcasvrsnc.supabase.co/functions/v1/sync-social',
       headers := jsonb_build_object('Content-Type', 'application/json',
                    'x-cron-key', (select cron_key from public.social_sync_config where id = 1)),
       body    := '{}'::jsonb,
       timeout_milliseconds := 60000) $$
);

-- which YouTube channel the numbers belong to; if the sign-in changes to
-- another channel, the Edge Function clears the old channel's rows
alter table public.social_sync_config add column if not exists youtube_channel_id text;

-- which Instagram account the numbers belong to (same idea as youtube_channel_id)
alter table public.social_sync_config add column if not exists instagram_user_id text;
