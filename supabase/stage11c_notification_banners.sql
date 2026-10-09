-- =====================================================================
-- STAGE 11c — a notification as a banner pinned on a page
--
-- WHAT THIS DOES, in plain words:
--   * A message can now also (or only) show as a BANNER at the top of one
--     page, e.g. Social Media → Ideation, above "All ideas", for a few days.
--       place        which page, e.g. 'social:<space id>:ideation' (empty = no banner)
--       place_until  the banner disappears by itself after this moment
--       bell         false = don't put it in the 🔔 bell (banner / pop-up only)
--   * A person can hide a banner for themselves (receipt hidden_at), through
--     mark_notification(id, 'hide'). "Stop" (stopped) removes it for everyone.
--
-- SAFETY: adds columns and replaces mark_notification(). Deletes nothing.
-- =====================================================================

begin;

alter table public.team_notifications
  add column bell        boolean not null default true,
  add column place       text check (place ~ '^[a-z]+:[A-Za-z0-9_-]{1,80}:[a-z]{1,30}$'),
  add column place_until timestamptz,
  add constraint team_notifications_place_until check (place is null or place_until is not null),
  add constraint team_notifications_shown_somewhere check (bell or popup or place is not null);

alter table public.notification_receipts add column hidden_at timestamptz;

create or replace function public.mark_notification(n_id uuid, what text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.notification_for_me(n_id) then
    raise exception 'This notification is not for you.';
  end if;
  if what not in ('shown','read','ack','hide') then raise exception 'Unknown: %', what; end if;
  insert into public.notification_receipts as r (notification_id, user_id, shown_count, last_shown_at, read_at, acked_at, hidden_at)
  values (n_id, auth.uid(),
          case when what = 'shown' then 1 else 0 end,
          case when what = 'shown' then now() end,
          case when what in ('read','ack','hide') then now() end,
          case when what = 'ack' then now() end,
          case when what = 'hide' then now() end)
  on conflict (notification_id, user_id) do update set
    shown_count   = r.shown_count + case when what = 'shown' then 1 else 0 end,
    last_shown_at = case when what = 'shown' then now() else r.last_shown_at end,
    read_at       = coalesce(r.read_at, case when what in ('read','ack','hide') then now() end),
    acked_at      = coalesce(r.acked_at, case when what = 'ack' then now() end),
    hidden_at     = coalesce(r.hidden_at, case when what = 'hide' then now() end);
end $$;

commit;
