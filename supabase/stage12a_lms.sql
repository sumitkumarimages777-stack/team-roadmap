-- =====================================================================
-- STAGE 12a — LMS: little learning "drops" for the team
--
-- WHAT THIS DOES, in plain words:
--   * New permission manage_learning ("Run LMS"). Owners always have it;
--     an owner can tick it on any role.
--   * learning_drops: one drop = a video and/or an article link, a friendly
--     intro line, and a few questions (pick-one, with an optional right
--     answer for quizzes, or a written answer).
--   * A drop reaches people as a notification (bell / pop-up / banner on a
--     page): team_notifications gets drop_id, and starts_at so a drop can be
--     scheduled — nobody sees a message before its starts_at.
--   * learning_answers: one set of answers per person per drop. Written only
--     through submit_learning(), which also scores quiz questions.
--   * learning_results(): how many picked each option — for people who have
--     answered (so they can compare with the team) and for LMS managers.
--   * Who can do what (enforced by the database):
--       - LMS managers create, edit, schedule and delete drops, and see
--         everyone's answers;
--       - a person sees a drop only once it has been sent to them, and
--         their own answers.
--
-- SAFETY: new tables, new columns, rules replaced with wider versions.
-- Deletes nothing.
-- =====================================================================

begin;

create or replace function public.all_perms() returns text[]
language sql immutable set search_path = '' as $$
  select array['view','comment','edit','delete','spaces','okr_structure','module_vision',
               'request_members','approve_requests','manage_people','create_games','edit_targets','edit_utm',
               'send_notifications','manage_learning']
$$;
update public.team_roles set perms = public.all_perms() where key = 'owner';

-- ---------- drops ----------
create table public.learning_drops (
  id          uuid primary key default gen_random_uuid(),
  team_slug   text not null references public.teams(slug) on delete cascade on update cascade,
  kind        text not null default 'video' check (kind in ('video','article','poll','quiz')),
  title       text not null check (length(trim(title)) between 1 and 140),
  intro       text not null default '' check (length(intro) <= 1000),
  video_id    text check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  url         text check (url ~* '^https?://' and length(url) <= 1000),
  note        text not null default '' check (length(note) <= 4000),
  questions   jsonb not null default '[]'::jsonb check (jsonb_typeof(questions) = 'array'),
  created_by  uuid default auth.uid() references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index learning_drops_team_idx on public.learning_drops(team_slug, created_at desc);

-- ---------- deliveries ride on notifications ----------
alter table public.team_notifications
  add column drop_id   uuid references public.learning_drops(id) on delete cascade,
  add column starts_at timestamptz not null default now();
grant update (starts_at) on public.team_notifications to authenticated;

-- may this person manage this notification? (sender, or LMS manager for a drop)
create function public.notification_manager(team text, d_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.has_perm(team, 'send_notifications')
      or (d_id is not null and public.has_perm(team, 'manage_learning'))
$$;

create or replace function public.notification_for_me(n_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_notifications n
    where n.id = n_id
      and n.starts_at <= now()
      and public.has_role(n.team_slug, 'viewer')
      and (n.audience = 'team' or auth.uid() = any(n.recipients)))
$$;
create or replace function public.notification_sender_can(n_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_notifications n
    where n.id = n_id and public.notification_manager(n.team_slug, n.drop_id))
$$;

alter policy "recipients and senders see notifications" on public.team_notifications
  using (public.notification_manager(team_slug, drop_id)
         or (starts_at <= now() and public.has_role(team_slug, 'viewer')
             and (audience = 'team' or auth.uid() = any(recipients))));
alter policy "senders send notifications" on public.team_notifications
  with check (public.notification_manager(team_slug, drop_id) and created_by = auth.uid() and not stopped
              and (drop_id is null or exists (select 1 from public.learning_drops d
                                              where d.id = team_notifications.drop_id and d.team_slug = team_notifications.team_slug)));
alter policy "senders stop notifications" on public.team_notifications
  using (public.notification_manager(team_slug, drop_id))
  with check (public.notification_manager(team_slug, drop_id));
alter policy "senders delete notifications" on public.team_notifications
  using (public.notification_manager(team_slug, drop_id));

-- has this drop been sent to me (and gone out)?
create function public.drop_for_me(d_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.team_notifications n
                 where n.drop_id = d_id and public.notification_for_me(n.id))
$$;

alter table public.learning_drops enable row level security;
revoke all on public.learning_drops from anon, authenticated;
grant select, insert, update, delete on public.learning_drops to authenticated;

create policy "managers and receivers see drops" on public.learning_drops
  for select to authenticated
  using (public.has_perm(team_slug, 'manage_learning') or public.drop_for_me(id));
create policy "managers add drops" on public.learning_drops
  for insert to authenticated
  with check (public.has_perm(team_slug, 'manage_learning') and created_by = auth.uid());
create policy "managers change drops" on public.learning_drops
  for update to authenticated
  using (public.has_perm(team_slug, 'manage_learning'))
  with check (public.has_perm(team_slug, 'manage_learning'));
create policy "managers remove drops" on public.learning_drops
  for delete to authenticated
  using (public.has_perm(team_slug, 'manage_learning'));

create function public.learning_drops_touch() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger learning_drops_touch before update on public.learning_drops
  for each row execute function public.learning_drops_touch();

-- ---------- answers ----------
create table public.learning_answers (
  drop_id      uuid not null references public.learning_drops(id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  answers      jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  score        int,
  total        int,
  submitted_at timestamptz not null default now(),
  primary key (drop_id, user_id)
);
alter table public.learning_answers enable row level security;
revoke all on public.learning_answers from anon, authenticated;
grant select on public.learning_answers to authenticated;

create function public.drop_manager(d_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.learning_drops d
                 where d.id = d_id and public.has_perm(d.team_slug, 'manage_learning'))
$$;
create policy "own answers, and managers see all" on public.learning_answers
  for select to authenticated
  using (user_id = auth.uid() or public.drop_manager(drop_id));

-- answer a drop (once). answers = {"<question id>": <option index> | "<text>"}
-- Quiz questions (with a right answer) are scored here, not in the browser.
create function public.submit_learning(d_id uuid, p_answers jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q jsonb; a jsonb; v_score int := 0; v_total int := 0; v_clean jsonb := '{}'::jsonb;
begin
  if auth.uid() is null or not public.drop_for_me(d_id) then raise exception 'This isn''t for you.'; end if;
  if exists (select 1 from public.learning_answers where drop_id = d_id and user_id = auth.uid()) then
    raise exception 'You already answered this one.';
  end if;
  if jsonb_typeof(p_answers) <> 'object' then raise exception 'Bad answers.'; end if;
  for q in select jsonb_array_elements(d.questions) from public.learning_drops d where d.id = d_id loop
    a := p_answers -> (q->>'id');
    if a is null then continue; end if;
    if q->>'type' = 'choice' then
      if jsonb_typeof(a) <> 'number' or (a::text)::int < 0
         or (a::text)::int >= jsonb_array_length(coalesce(q->'options','[]'::jsonb)) then continue; end if;
      v_clean := v_clean || jsonb_build_object(q->>'id', (a::text)::int);
      if jsonb_typeof(q->'correct') = 'number' then
        v_total := v_total + 1;
        if (a::text)::int = (q->>'correct')::int then v_score := v_score + 1; end if;
      end if;
    elsif jsonb_typeof(a) = 'string' then
      v_clean := v_clean || jsonb_build_object(q->>'id', left(a #>> '{}', 2000));
    end if;
  end loop;
  insert into public.learning_answers (drop_id, user_id, answers, score, total)
  values (d_id, auth.uid(), v_clean, case when v_total > 0 then v_score end, case when v_total > 0 then v_total end);
  return jsonb_build_object('score', v_score, 'total', v_total);
end $$;

-- how many picked each option: {"<question id>": [n0, n1, ...], "_answered": n}
create function public.learning_results(d_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare q jsonb; res jsonb := '{}'::jsonb; counts jsonb; i int;
begin
  if not (public.drop_manager(d_id)
          or exists (select 1 from public.learning_answers where drop_id = d_id and user_id = auth.uid())) then
    raise exception 'Answer it first to see what the team picked.';
  end if;
  for q in select jsonb_array_elements(d.questions) from public.learning_drops d where d.id = d_id loop
    if q->>'type' = 'choice' then
      counts := '[]'::jsonb;
      for i in 0 .. jsonb_array_length(coalesce(q->'options','[]'::jsonb)) - 1 loop
        counts := counts || to_jsonb((select count(*) from public.learning_answers la
                                      where la.drop_id = d_id and la.answers->>(q->>'id') = i::text));
      end loop;
      res := res || jsonb_build_object(q->>'id', counts);
    end if;
  end loop;
  return res || jsonb_build_object('_answered', (select count(*) from public.learning_answers where drop_id = d_id));
end $$;

revoke execute on function public.notification_manager(text, uuid), public.drop_for_me(uuid), public.drop_manager(uuid),
                           public.submit_learning(uuid, jsonb), public.learning_results(uuid) from public, anon;
grant execute on function public.notification_manager(text, uuid), public.drop_for_me(uuid), public.drop_manager(uuid),
                          public.submit_learning(uuid, jsonb), public.learning_results(uuid) to authenticated;
revoke execute on function public.learning_drops_touch() from public, anon, authenticated;

commit;
