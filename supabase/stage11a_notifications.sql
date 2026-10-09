-- =====================================================================
-- STAGE 11a — Notifications (🔔 bell + pop-ups)
--
-- WHAT THIS DOES, in plain words:
--   * A new permission, send_notifications ("Send notifications"). Owners
--     always have it; an owner can tick it on any other role in
--     Administration -> Roles & permissions.
--   * team_notifications: a message sent to the whole team or to chosen
--     people. Each one shows in the 🔔 bell, and can also pop up:
--       popup_rule  'once'      pop up one time
--                   'times'     pop up popup_times times (1-20)
--                   'until_ack' keep popping up until they press "Got it"
--       popup_gap   'visit'     at most once per app visit
--                   'day'       at most once per day
--       show_until  optional: stop popping up after this moment
--   * notification_receipts: per person, per message — how many times it
--     popped up, when it was read, when they pressed "Got it". Senders see
--     these so they know who has seen it.
--   * Who can do what (enforced by the database):
--       - a person sees only messages for the whole team or for them;
--       - roles with send_notifications see and send every message of the
--         team, and can stop or delete them;
--       - a person can only write their OWN receipts, and only through
--         mark_notification() (popped up / read / got it).
--
-- SAFETY: creates two tables and their rules, adds one permission name to
-- the list (Owners get it). Deletes nothing.
-- =====================================================================

begin;

create or replace function public.all_perms() returns text[]
language sql immutable set search_path = '' as $$
  select array['view','comment','edit','delete','spaces','okr_structure','module_vision',
               'request_members','approve_requests','manage_people','create_games','edit_targets','edit_utm',
               'send_notifications']
$$;

update public.team_roles set perms = public.all_perms() where key = 'owner';

create table public.team_notifications (
  id           uuid primary key default gen_random_uuid(),
  team_slug    text not null references public.teams(slug) on delete cascade on update cascade,
  title        text not null check (length(trim(title)) between 1 and 140),
  body         text not null default '' check (length(body) <= 4000),
  audience     text not null default 'team' check (audience in ('team','people')),
  recipients   uuid[] not null default '{}',
  popup        boolean not null default false,
  popup_rule   text not null default 'once' check (popup_rule in ('once','times','until_ack')),
  popup_times  int  not null default 1 check (popup_times between 1 and 20),
  popup_gap    text not null default 'visit' check (popup_gap in ('visit','day')),
  show_until   timestamptz,
  stopped      boolean not null default false,
  created_by   uuid default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  check (audience = 'team' or cardinality(recipients) > 0)
);
create index team_notifications_team_idx on public.team_notifications(team_slug, created_at desc);

create table public.notification_receipts (
  notification_id uuid not null references public.team_notifications(id) on delete cascade,
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  shown_count     int  not null default 0 check (shown_count >= 0),
  last_shown_at   timestamptz,
  read_at         timestamptz,
  acked_at        timestamptz,
  primary key (notification_id, user_id)
);

-- "is this message for me?" (used by the rules below)
create function public.notification_for_me(n_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_notifications n
    where n.id = n_id
      and public.has_role(n.team_slug, 'viewer')
      and (n.audience = 'team' or auth.uid() = any(n.recipients)))
$$;
create function public.notification_sender_can(n_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_notifications n
    where n.id = n_id and public.has_perm(n.team_slug, 'send_notifications'))
$$;

alter table public.team_notifications    enable row level security;
alter table public.notification_receipts enable row level security;
revoke all on public.team_notifications, public.notification_receipts from anon;
revoke all on public.team_notifications, public.notification_receipts from authenticated;
grant select, insert, delete on public.team_notifications to authenticated;
grant update (stopped) on public.team_notifications to authenticated;
grant select on public.notification_receipts to authenticated;

create policy "recipients and senders see notifications" on public.team_notifications
  for select to authenticated
  using (public.has_perm(team_slug, 'send_notifications')
         or (public.has_role(team_slug, 'viewer') and (audience = 'team' or auth.uid() = any(recipients))));

create policy "senders send notifications" on public.team_notifications
  for insert to authenticated
  with check (public.has_perm(team_slug, 'send_notifications') and created_by = auth.uid() and not stopped);

create policy "senders stop notifications" on public.team_notifications
  for update to authenticated
  using (public.has_perm(team_slug, 'send_notifications'))
  with check (public.has_perm(team_slug, 'send_notifications'));

create policy "senders delete notifications" on public.team_notifications
  for delete to authenticated
  using (public.has_perm(team_slug, 'send_notifications'));

create policy "own receipts, and senders see all" on public.notification_receipts
  for select to authenticated
  using (user_id = auth.uid() or public.notification_sender_can(notification_id));

-- the only way to write a receipt: for yourself, for a message meant for you.
--   what = 'shown' (it popped up), 'read' (opened in the bell), 'ack' (Got it)
create function public.mark_notification(n_id uuid, what text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.notification_for_me(n_id) then
    raise exception 'This notification is not for you.';
  end if;
  if what not in ('shown','read','ack') then raise exception 'Unknown: %', what; end if;
  insert into public.notification_receipts as r (notification_id, user_id, shown_count, last_shown_at, read_at, acked_at)
  values (n_id, auth.uid(),
          case when what = 'shown' then 1 else 0 end,
          case when what = 'shown' then now() end,
          case when what in ('read','ack') then now() end,
          case when what = 'ack' then now() end)
  on conflict (notification_id, user_id) do update set
    shown_count   = r.shown_count + case when what = 'shown' then 1 else 0 end,
    last_shown_at = case when what = 'shown' then now() else r.last_shown_at end,
    read_at       = coalesce(r.read_at, case when what in ('read','ack') then now() end),
    acked_at      = coalesce(r.acked_at, case when what = 'ack' then now() end);
end $$;

revoke execute on function public.notification_for_me(uuid), public.notification_sender_can(uuid),
                           public.mark_notification(uuid, text) from public, anon;
grant execute on function public.notification_for_me(uuid), public.notification_sender_can(uuid),
                          public.mark_notification(uuid, text) to authenticated;

commit;
