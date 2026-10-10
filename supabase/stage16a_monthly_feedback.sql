-- =====================================================================
-- STAGE 16a — Monthly feedback + the suggestion box
--
-- 1. Monthly feedback. Every teammate looks back at their month in a form
--    (Administration → 📝 My monthly feedback). The form opens on the team's
--    open day (default the 25th, India time) and is due on the last day of the
--    month; it can still be sent "late" until the 10th of the next month.
--    Drafts are private. Once sent, it is locked and readable by:
--      · the person themselves,
--      · everyone ABOVE them in the org chart (My Team → Reporting lines),
--        once their boxes are linked to logins (node.uid),
--      · super-admins (Sumit).
--    Nobody else — not even an owner from another branch of the chart.
--    Seniors then write the review-meeting notes on it (feedback_meeting).
--
-- 2. Daily reminders. A pg_cron job (09:30 India time) puts one reminder per
--    person per month in their 🔔, which also pops up once a day, until they
--    send it; sending stops it (team_notifications.ref = 'feedback:YYYY-MM').
--
-- 3. Suggestion box. Anyone in the team can send Sumit a suggestion,
--    improvement, complaint, appreciation or anything else — with their name
--    or anonymously. Anonymous ones store NO sender and only the day, not the
--    time. Only super-admins can read the box.
--
-- 4. The org chart now decides who reads whose feedback, so only owners (and
--    super-admins) may save it (can_write_section 'orgChart').
--
-- Every write goes through the functions below (security definer); the tables
-- have no insert/update policies for normal users.
-- =====================================================================

-- ---------- settings: on/off and the day the form opens ----------
create table if not exists public.feedback_settings (
  team_slug  text primary key references public.teams(slug) on update cascade on delete cascade,
  enabled    boolean not null default true,
  open_day   int not null default 25 check (open_day between 1 and 28),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references auth.users(id) on delete set null
);
alter table public.feedback_settings enable row level security;
create policy "members read feedback settings" on public.feedback_settings
  for select using (public.has_role(team_slug, 'viewer'));

insert into public.feedback_settings (team_slug) select slug from public.teams where slug = 'dubuddy'
  on conflict (team_slug) do nothing;

-- ---------- the feedback itself: one per person per month ----------
create table if not exists public.monthly_feedback (
  id            uuid primary key default gen_random_uuid(),
  team_slug     text not null references public.teams(slug) on update cascade on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  month         text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  answers       jsonb not null default '{}'::jsonb,
  status        text not null default 'draft' check (status in ('draft', 'submitted')),
  submitted_at  timestamptz,
  late          boolean not null default false,
  updated_at    timestamptz not null default now(),
  meeting_notes text check (length(meeting_notes) <= 8000),
  discussed_at  timestamptz,
  discussed_by  uuid references auth.users(id) on delete set null,
  unique (team_slug, user_id, month)
);
create index if not exists monthly_feedback_team_month on public.monthly_feedback (team_slug, month);
alter table public.monthly_feedback enable row level security;

-- reminders point back at the month they are about
alter table public.team_notifications add column if not exists ref text;
create index if not exists team_notifications_ref on public.team_notifications (team_slug, ref) where ref is not null;

-- ---------- the reporting line ----------
-- everyone below me in this team's org chart (boxes linked to a login with "uid")
create or replace function public.fb_reports(team text)
returns setof uuid language sql stable security definer set search_path = '' as $$
  with recursive t(node, path) as (
    select d.data, array[]::text[]
      from public.team_data d
     where d.team_slug = team and d.section = 'orgChart' and jsonb_typeof(d.data) = 'object'
    union all
    select c.value, t.path || coalesce(t.node->>'uid', '')
      from t cross join lateral jsonb_array_elements(
             case when jsonb_typeof(t.node->'children') = 'array' then t.node->'children' else '[]'::jsonb end) c
  )
  select distinct (t.node->>'uid')::uuid
    from t
   where auth.uid() is not null
     and public.has_role(team, 'viewer')
     and auth.uid()::text = any(t.path)
     and coalesce(t.node->>'uid', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and t.node->>'uid' <> auth.uid()::text
$$;

-- the nearest linked person above someone (gets the "feedback sent" 🔔)
create or replace function public.fb_manager_of(team text, subject uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  with recursive t(node, path) as (
    select d.data, array[]::text[]
      from public.team_data d
     where d.team_slug = team and d.section = 'orgChart' and jsonb_typeof(d.data) = 'object'
    union all
    select c.value, t.path || coalesce(t.node->>'uid', '')
      from t cross join lateral jsonb_array_elements(
             case when jsonb_typeof(t.node->'children') = 'array' then t.node->'children' else '[]'::jsonb end) c
  )
  select u.x::uuid
    from t, unnest(t.path) with ordinality u(x, i)
   where t.node->>'uid' = subject::text
     and u.x ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and u.x <> subject::text
   order by u.i desc
   limit 1
$$;

create policy "you, your seniors and super-admins read feedback" on public.monthly_feedback
  for select using (
    user_id = auth.uid()
    or (status = 'submitted' and (public.is_super() or user_id in (select public.fb_reports(team_slug))))
  );

-- 'open' (from the open day to month end), 'late' (until the 10th of the next month) or 'closed'
create or replace function public.feedback_window(p_team text, p_month text)
returns text language sql stable security definer set search_path = '' as $$
  with n as (select (now() at time zone 'Asia/Kolkata') as l),
       s as (select coalesce((select f.enabled from public.feedback_settings f where f.team_slug = p_team), true) as en,
                    coalesce((select f.open_day from public.feedback_settings f where f.team_slug = p_team), 25) as od)
  select case
    when not s.en then 'closed'
    when p_month = to_char(n.l, 'YYYY-MM') and extract(day from n.l) >= s.od then 'open'
    when p_month = to_char(n.l - interval '1 month', 'YYYY-MM') and extract(day from n.l) <= 10 then 'late'
    else 'closed' end
  from n, s
$$;

-- ---------- writing it: save a draft, or send it ----------
create or replace function public.feedback_save(p_team text, p_month text, p_answers jsonb, p_submit boolean)
returns public.monthly_feedback language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  w text;
  r public.monthly_feedback;
  mgr uuid;
  who text;
begin
  if me is null or not public.has_role(p_team, 'viewer') then raise exception 'Sign in to this team first.'; end if;
  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'Bad month.'; end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' or length(p_answers::text) > 40000 then
    raise exception 'The answers are too long.';
  end if;
  w := public.feedback_window(p_team, p_month);
  if w = 'closed' then raise exception 'Feedback for this month isn''t open.'; end if;
  select * into r from public.monthly_feedback f where f.team_slug = p_team and f.user_id = me and f.month = p_month;
  if found and r.status = 'submitted' then raise exception 'You already sent this month''s feedback.'; end if;

  insert into public.monthly_feedback as f (team_slug, user_id, month, answers, status, submitted_at, late, updated_at)
  values (p_team, me, p_month, p_answers,
          case when p_submit then 'submitted' else 'draft' end,
          case when p_submit then now() end,
          coalesce(p_submit, false) and w = 'late', now())
  on conflict (team_slug, user_id, month) do update
    set answers = excluded.answers, status = excluded.status, submitted_at = excluded.submitted_at,
        late = excluded.late, updated_at = now()
  returning * into r;

  if p_submit then
    -- the daily reminder stops
    update public.team_notifications n set stopped = true
     where n.team_slug = p_team and n.ref = 'feedback:' || p_month and n.recipients = array[me];
    -- the nearest senior hears about it
    mgr := public.fb_manager_of(p_team, me);
    if mgr is not null and mgr <> me then
      select coalesce(nullif(p.profile->>'displayName', ''), p.name, 'A teammate') into who from public.profiles p where p.id = me;
      insert into public.team_notifications (team_slug, title, body, audience, recipients, bell, popup, created_by)
      values (p_team,
              left('📝 ' || who || ' sent their ' || to_char(to_date(p_month || '-01', 'YYYY-MM-DD'), 'FMMonth') || ' feedback', 140),
              'Read it in My Team → Monthly feedback before your review meeting.',
              'people', array[mgr], true, false, me);
    end if;
  end if;
  return r;
end $$;

-- ---------- who has sent theirs (for My Team → Monthly feedback) ----------
-- super-admins: every member; everyone else: themselves + the people below them
create or replace function public.feedback_overview(p_team text, p_month text)
returns table (user_id uuid, status text, submitted_at timestamptz, late boolean, discussed_at timestamptz, feedback_id uuid)
language sql stable security definer set search_path = '' as $$
  with people as (
    select m.user_id from public.memberships m
     where m.team_slug = p_team
       and public.has_role(p_team, 'viewer')
       and (public.is_super() or m.user_id = auth.uid() or m.user_id in (select public.fb_reports(p_team)))
  )
  select p.user_id,
         coalesce(f.status, 'none'),
         f.submitted_at,
         coalesce(f.late, false),
         case when f.status = 'submitted' then f.discussed_at end,
         case when f.status = 'submitted' or p.user_id = auth.uid() then f.id end
    from people p
    left join public.monthly_feedback f on f.team_slug = p_team and f.user_id = p.user_id and f.month = p_month
$$;

-- ---------- the review meeting: notes + "discussed" ----------
create or replace function public.feedback_meeting(p_id uuid, p_notes text, p_discussed boolean)
returns public.monthly_feedback language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  r public.monthly_feedback;
  was timestamptz;
begin
  select * into r from public.monthly_feedback f where f.id = p_id;
  if not found or r.status <> 'submitted' then raise exception 'That feedback isn''t sent yet.'; end if;
  if r.user_id = me then raise exception 'Your seniors write the meeting notes on your feedback.'; end if;
  if not (public.is_super() or r.user_id in (select public.fb_reports(r.team_slug))) then raise exception 'Not allowed.'; end if;
  was := r.discussed_at;
  update public.monthly_feedback f
     set meeting_notes = nullif(left(trim(coalesce(p_notes, '')), 8000), ''),
         discussed_at  = case when p_discussed then coalesce(f.discussed_at, now()) end,
         discussed_by  = case when p_discussed then coalesce(f.discussed_by, me) end
   where f.id = p_id
  returning * into r;
  if p_discussed and was is null then
    insert into public.team_notifications (team_slug, title, body, audience, recipients, bell, popup, created_by)
    values (r.team_slug, '🤝 Notes from your feedback review',
            left(coalesce(r.meeting_notes, 'Your ' || to_char(to_date(r.month || '-01', 'YYYY-MM-DD'), 'FMMonth') || ' feedback was discussed.')
                 || E'\n\nSee them in Administration → My monthly feedback.', 4000),
            'people', array[r.user_id], true, false, me);
  end if;
  return r;
end $$;

-- ---------- settings (owners and super-admins) ----------
create or replace function public.feedback_set_settings(p_team text, p_enabled boolean, p_open_day int)
returns public.feedback_settings language plpgsql security definer set search_path = '' as $$
declare s public.feedback_settings;
begin
  if public.my_role(p_team) <> 'owner' then raise exception 'Only owners can change this.'; end if;
  if p_open_day is null or p_open_day < 1 or p_open_day > 28 then raise exception 'Pick a day between 1 and 28.'; end if;
  insert into public.feedback_settings as f (team_slug, enabled, open_day, updated_at, updated_by)
  values (p_team, coalesce(p_enabled, true), p_open_day, now(), auth.uid())
  on conflict (team_slug) do update set enabled = excluded.enabled, open_day = excluded.open_day, updated_at = now(), updated_by = auth.uid()
  returning * into s;
  perform public.feedback_remind();      -- if the form is open now, reminders go out now
  return s;
end $$;

-- ---------- the daily reminder (pg_cron, 09:30 India time) ----------
create or replace function public.feedback_remind()
returns int language plpgsql security definer set search_path = '' as $$
declare
  l timestamp := now() at time zone 'Asia/Kolkata';
  cur text := to_char(l, 'YYYY-MM');
  lbl text := to_char(l, 'FMMonth');
  due text := to_char(date_trunc('month', l) + interval '1 month' - interval '1 day', 'FMDD FMMonth');
  untl timestamptz := (date_trunc('month', l) + interval '1 month' + interval '10 days') at time zone 'Asia/Kolkata';
  s record;
  n int := 0;
  k int;
begin
  for s in select * from public.feedback_settings where enabled loop
    if extract(day from l) >= s.open_day then
      insert into public.team_notifications
        (team_slug, title, body, audience, recipients, popup, popup_rule, popup_times, popup_gap, show_until, bell, created_by, ref)
      select s.team_slug,
             '📝 Your ' || lbl || ' feedback is open',
             'Take 10 minutes to look back at your month — what went well, what got in the way, and what you need. '
               || 'Find it in Administration → 📝 My monthly feedback. You can save a draft and finish it later. Please send it by ' || due || '.',
             'people', array[m.user_id], true, 'times', 20, 'day', untl, true, null, 'feedback:' || cur
        from public.memberships m
       where m.team_slug = s.team_slug
         and not exists (select 1 from public.monthly_feedback f
                          where f.team_slug = s.team_slug and f.user_id = m.user_id and f.month = cur and f.status = 'submitted')
         and not exists (select 1 from public.team_notifications x
                          where x.team_slug = s.team_slug and x.ref = 'feedback:' || cur and x.recipients = array[m.user_id]);
      get diagnostics k = row_count;
      n := n + k;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public.feedback_remind() from public, anon, authenticated;

select cron.schedule('feedback-reminders', '0 4 * * *', 'select public.feedback_remind()');

-- ---------- the suggestion box: straight to Sumit ----------
create table if not exists public.suggestion_box (
  id         uuid primary key default gen_random_uuid(),
  team_slug  text not null references public.teams(slug) on update cascade on delete cascade,
  kind       text not null check (kind in ('suggestion', 'improvement', 'complaint', 'appreciation', 'other')),
  body       text not null check (length(trim(body)) between 3 and 5000),
  from_user  uuid references auth.users(id) on delete set null,   -- null = anonymous
  created_on date not null default (now() at time zone 'Asia/Kolkata')::date,
  created_at timestamptz,                                         -- only kept when sent with a name
  status     text not null default 'new' check (status in ('new', 'read', 'done')),
  note       text check (length(note) <= 4000)                    -- Sumit's own note
);
create index if not exists suggestion_box_team on public.suggestion_box (team_slug, created_on desc);
alter table public.suggestion_box enable row level security;
create policy "super-admins read the box; senders their named ones" on public.suggestion_box
  for select using (public.is_super() or from_user = auth.uid());
create policy "super-admins mark the box" on public.suggestion_box
  for update using (public.is_super()) with check (public.is_super());

create or replace function public.suggestion_send(p_team text, p_kind text, p_body text, p_anonymous boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  anon boolean := coalesce(p_anonymous, true);
  who text;
  lbl text;
  sup uuid[];
begin
  if me is null or not public.has_role(p_team, 'viewer') then raise exception 'Sign in to this team first.'; end if;
  if p_kind not in ('suggestion', 'improvement', 'complaint', 'appreciation', 'other') then raise exception 'Pick what it is.'; end if;
  if length(trim(coalesce(p_body, ''))) < 3 then raise exception 'Write a little more.'; end if;
  if (select count(*) from public.suggestion_box b
       where b.team_slug = p_team and b.created_on = (now() at time zone 'Asia/Kolkata')::date) >= 100 then
    raise exception 'The box is full for today — please try tomorrow.';
  end if;
  insert into public.suggestion_box (team_slug, kind, body, from_user, created_at)
  values (p_team, p_kind, left(trim(p_body), 5000), case when anon then null else me end, case when anon then null else now() end);

  lbl := case p_kind when 'suggestion' then 'suggestion' when 'improvement' then 'improvement idea' when 'complaint' then 'complaint'
                     when 'appreciation' then 'appreciation' else 'message' end;
  select array_agg(p.id) into sup from public.profiles p where p.is_super;
  if sup is not null then
    if not anon then
      select coalesce(nullif(p.profile->>'displayName', ''), p.name, 'A teammate') into who from public.profiles p where p.id = me;
    end if;
    insert into public.team_notifications (team_slug, title, body, audience, recipients, bell, popup, created_by)
    values (p_team,
            left(case when anon then '📮 New anonymous ' || lbl else '📮 New ' || lbl || ' from ' || who end, 140),
            'Open Administration → 📮 Suggestion box to read it.',
            'people', sup, true, false, case when anon then null else me end);
  end if;
  return true;
end $$;

-- ---------- only owners (and super-admins) may change the org chart ----------
create or replace function public.can_write_section(team text, sec text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when sec in ('kim', 'teamIdeas', 'utmLinks') then public.has_role(team, 'viewer')
    when sec = 'socialTargets' then public.has_perm(team, 'edit_targets')
    when sec = 'utmRules' then public.has_perm(team, 'edit_utm')
    when sec = 'orgChart' then public.my_role(team) = 'owner'     -- it decides who reads whose feedback
    else public.has_perm(team, 'edit') or public.has_perm(team, 'comment') or public.has_perm(team, 'delete')
      or public.has_perm(team, 'spaces') or public.has_perm(team, 'okr_structure') or public.has_perm(team, 'module_vision')
  end
$$;
