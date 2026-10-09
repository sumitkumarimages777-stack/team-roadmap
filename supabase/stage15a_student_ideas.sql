-- =====================================================================
-- STAGE 15a — Student ideas board (tools.dubuddy.in/ideas) + idea emails
--
-- WHAT THIS DOES, in plain words:
--   * student_ideas: ideas students send from the public board (no login).
--     A new idea is 'pending' — nobody sees it publicly until the team
--     approves it. Public statuses: review (In review), planned,
--     progress (In progress), done (Completed), declined (Not planned).
--     Hidden: pending, rejected, merged.
--   * student_idea_votes: one vote per browser per idea.
--   * The public page (signed out) only ever calls these functions:
--       ideas_board, ideas_submit, ideas_vote, ideas_my_votes, ideas_mine
--     Students never see each other's email; names show as first name only.
--     Sending is limited to 5 ideas a day per browser (40 per network).
--   * The team (new permission review_student_ideas, "Review student
--     ideas"; Owners always) reads the inbox and approves / rejects / merges
--     through student_idea_set. Moving an approved idea on the product
--     roadmap updates its public status (anyone who can edit).
--   * Team product pitches (stage14a) now remember which product idea they
--     became, so people can follow their own pitches (my_pitches /
--     pitches_by_ids) and get emails when they move.
--   * idea_mail_target: the email address for a student idea or a named
--     pitch — only for people who can edit — used by the idea-mail function.
--
-- SAFETY: new tables/functions, new columns. Deletes nothing.
-- =====================================================================

begin;

create or replace function public.all_perms() returns text[]
language sql immutable set search_path = '' as $$
  select array['view','comment','edit','delete','spaces','okr_structure','module_vision',
               'request_members','approve_requests','manage_people','create_games','edit_targets','edit_utm',
               'send_notifications','manage_learning','add_spaces','delete_spaces','add_roadmaps','delete_roadmaps',
               'review_student_ideas']
$$;
update public.team_roles set perms = public.all_perms() where key = 'owner';

-- ---------- student ideas ----------
create table public.student_ideas (
  id           uuid primary key default gen_random_uuid(),
  team_slug    text not null references public.teams(slug) on delete cascade on update cascade,
  title        text not null check (length(trim(title)) between 3 and 140),
  details      text not null default '' check (length(details) <= 3000),
  category     text not null default 'other' check (category ~ '^[a-z-]{1,30}$'),
  name         text check (length(name) <= 60),
  email        text check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 200),
  status       text not null default 'pending'
               check (status in ('pending','review','planned','progress','done','declined','rejected','merged')),
  merged_into  uuid references public.student_ideas(id) on delete set null,
  votes        int not null default 0,
  reply        text check (length(reply) <= 2000),
  reply_at     timestamptz,
  space_id     text,              -- the product space it was filed into
  idea_ref     text,              -- the idea id inside that space
  device       text check (length(device) <= 64),
  net          text,              -- hashed network address, only for the daily limit
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);
create index student_ideas_team_idx on public.student_ideas(team_slug, status, created_at desc);

create table public.student_idea_votes (
  idea_id    uuid not null references public.student_ideas(id) on delete cascade,
  device     text not null check (length(device) between 8 and 64),
  active     boolean not null default true,      -- un-voting switches it off
  created_at timestamptz not null default now(),
  primary key (idea_id, device)
);

alter table public.student_ideas      enable row level security;
alter table public.student_idea_votes enable row level security;
revoke all on public.student_ideas, public.student_idea_votes from anon, authenticated;
grant select on public.student_ideas to authenticated;
create policy "reviewers and editors read student ideas" on public.student_ideas
  for select to authenticated
  using (public.has_perm(team_slug, 'review_student_ideas') or public.has_perm(team_slug, 'edit'));

create function public.ideas_public_status(s text) returns boolean
language sql immutable set search_path = '' as $$ select s in ('review','planned','progress','done','declined') $$;

-- the public board: approved ideas only, no emails, first names only
create function public.ideas_board(p_team text)
returns table (id uuid, title text, details text, category text, name text, status text, votes int,
               reply text, reply_at timestamptz, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, i.title, i.details, i.category, nullif(split_part(trim(coalesce(i.name,'')), ' ', 1), ''),
         i.status, i.votes, i.reply, i.reply_at, i.created_at
  from public.student_ideas i
  where i.team_slug = p_team and public.ideas_public_status(i.status)
  order by i.votes desc, i.created_at desc
  limit 500
$$;

create function public.ideas_net() returns text
language sql stable set search_path = '' as $$
  select md5('dubuddy-ideas:' || coalesce(split_part(
           coalesce((current_setting('request.headers', true))::json->>'x-forwarded-for', ''), ',', 1), ''))
$$;

create function public.ideas_submit(p_team text, p_title text, p_details text, p_category text,
                                    p_name text, p_email text, p_device text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_net text := public.ideas_net();
begin
  if not exists (select 1 from public.teams where slug = p_team) then raise exception 'Unknown board.'; end if;
  if length(trim(coalesce(p_title,''))) < 3 then raise exception 'Give your idea a short title.'; end if;
  if coalesce(length(p_device), 0) not between 8 and 64 then raise exception 'Please reload the page and try again.'; end if;
  -- 5 a day per browser; 40 a day per network (many students share one mobile/college address)
  if (select count(*) from public.student_ideas where created_at > now() - interval '1 day' and device = p_device) >= 5
     or (select count(*) from public.student_ideas where created_at > now() - interval '1 day' and net = v_net) >= 40 then
    raise exception 'That''s a lot of ideas today 🙂 Please try again tomorrow.';
  end if;
  insert into public.student_ideas (team_slug, title, details, category, name, email, device, net)
  values (p_team, left(trim(p_title), 140), left(trim(coalesce(p_details,'')), 3000),
          coalesce(nullif(lower(p_category), ''), 'other'),
          nullif(left(trim(coalesce(p_name,'')), 60), ''),
          nullif(lower(trim(coalesce(p_email,''))), ''),
          p_device, v_net)
  returning id into v_id;
  return v_id;
end $$;

create function public.ideas_vote(p_id uuid, p_device text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_on boolean; v_n int;
begin
  if coalesce(length(p_device), 0) not between 8 and 64 then raise exception 'Please reload the page and try again.'; end if;
  if not exists (select 1 from public.student_ideas where id = p_id and public.ideas_public_status(status)) then
    raise exception 'This idea is not open for votes.';
  end if;
  insert into public.student_idea_votes as v (idea_id, device) values (p_id, p_device)
  on conflict (idea_id, device) do update set active = not v.active, created_at = now()
  returning active into v_on;
  select count(*) into v_n from public.student_idea_votes where idea_id = p_id and active;
  update public.student_ideas set votes = v_n where id = p_id;
  return jsonb_build_object('voted', v_on, 'votes', v_n);
end $$;

create function public.ideas_my_votes(p_team text, p_device text) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select v.idea_id from public.student_idea_votes v join public.student_ideas i on i.id = v.idea_id
  where v.device = p_device and v.active and i.team_slug = p_team
$$;

-- "your ideas" on the public page: what this browser sent, including ones still in review
create function public.ideas_mine(p_ids uuid[])
returns table (id uuid, title text, status text, reply text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, i.title,
         case when i.status = 'merged' then 'review' when i.status = 'rejected' then 'declined' else i.status end,
         i.reply, i.created_at
  from public.student_ideas i where i.id = any(p_ids[1:50])
$$;

-- the team: approve / reject / merge / move / reply
--   p_action: 'approve' | 'reject' | 'merge' | 'status' | 'reply' | 'link'
create function public.student_idea_set(p_id uuid, p_action text, p_value text default null,
                                        p_space text default null, p_ref text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_team text; v_target uuid;
begin
  select team_slug into v_team from public.student_ideas where id = p_id;
  if v_team is null then raise exception 'Idea not found.'; end if;
  if p_action in ('approve','reject','merge') and not public.has_perm(v_team, 'review_student_ideas') then
    raise exception 'Only people who review student ideas can do that.';
  end if;
  if p_action in ('status','reply','link') and not (public.has_perm(v_team, 'edit') or public.has_perm(v_team, 'review_student_ideas')) then
    raise exception 'Not allowed.';
  end if;
  if p_action = 'approve' then
    update public.student_ideas set status = 'review', decided_at = now(), space_id = p_space, idea_ref = p_ref where id = p_id;
  elsif p_action = 'reject' then
    update public.student_ideas set status = 'rejected', decided_at = now(),
      reply = coalesce(nullif(trim(p_value), ''), reply), reply_at = case when nullif(trim(p_value), '') is null then reply_at else now() end
    where id = p_id;
  elsif p_action = 'merge' then
    v_target := p_value::uuid;
    if v_target = p_id or not exists (select 1 from public.student_ideas where id = v_target and team_slug = v_team
                                     and public.ideas_public_status(status)) then
      raise exception 'Pick an approved idea to merge into.';
    end if;
    insert into public.student_idea_votes (idea_id, device)
      select v_target, device from public.student_idea_votes where idea_id = p_id and active
      on conflict (idea_id, device) do update set active = true;
    if (select device from public.student_ideas where id = p_id) is not null then
      insert into public.student_idea_votes (idea_id, device)
        select v_target, device from public.student_ideas where id = p_id
        on conflict (idea_id, device) do update set active = true;   -- the author's vote
    end if;
    update public.student_ideas set votes = (select count(*) from public.student_idea_votes where idea_id = v_target and active) where id = v_target;
    update public.student_ideas set status = 'merged', merged_into = v_target, decided_at = now() where id = p_id;
  elsif p_action = 'status' then
    if p_value not in ('review','planned','progress','done','declined') then raise exception 'Unknown status.'; end if;
    update public.student_ideas set status = p_value where id = p_id and public.ideas_public_status(status);
  elsif p_action = 'reply' then
    update public.student_ideas set reply = nullif(left(trim(coalesce(p_value,'')), 2000), ''), reply_at = now() where id = p_id;
  elsif p_action = 'link' then
    update public.student_ideas set space_id = p_space, idea_ref = p_ref where id = p_id;
  else
    raise exception 'Unknown action.';
  end if;
end $$;

-- ---------- team pitches: remember the idea they became ----------
alter table public.product_pitches add column idea_ref text, add column space_id text;
create function public.link_pitch(p_id uuid, p_space text, p_ref text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.product_pitches set space_id = p_space, idea_ref = p_ref
  where id = p_id and public.has_perm(team_slug, 'edit');
end $$;

-- same as submit_product_pitch (stage14a) but returns the new pitch's id, so the
-- sender's browser can follow an anonymous pitch without anyone storing who sent it
create function public.pitch_submit(p_team text, p_body text, p_anonymous boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_name text; v_id uuid;
begin
  if not public.has_role(p_team, 'viewer') then raise exception 'You are not in this team.'; end if;
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'Write something first.'; end if;
  if not p_anonymous then
    select coalesce(nullif(p.profile->>'displayName', ''), nullif(p.name, ''), p.email) into v_name
    from public.profiles p where p.id = auth.uid();
  end if;
  insert into public.product_pitches (team_slug, body, by_user, by_name)
  values (p_team, left(trim(p_body), 4000),
          case when p_anonymous then null else auth.uid() end,
          case when p_anonymous then null else v_name end)
  returning id into v_id;
  return v_id;
end $$;

-- my named pitches, plus anonymous ones this browser remembers (by id)
create function public.my_pitches(p_team text, p_ids uuid[] default '{}')
returns table (id uuid, body text, anonymous boolean, created_at timestamptz, claimed boolean, space_id text, idea_ref text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.body, p.by_user is null, p.created_at, p.claimed_at is not null, p.space_id, p.idea_ref
  from public.product_pitches p
  where p.team_slug = p_team and public.has_role(p_team, 'viewer')
    and (p.by_user = auth.uid() or p.id = any(p_ids[1:100]))
  order by p.created_at desc
$$;

-- who to email about an idea (editors only); kind: 'student' | 'pitch'
create function public.idea_mail_target(p_kind text, p_id uuid)
returns table (email text, name text, title text, team text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_kind = 'student' then
    return query select i.email, coalesce(i.name, ''), i.title, i.team_slug from public.student_ideas i
      where i.id = p_id and (public.has_perm(i.team_slug, 'edit') or public.has_perm(i.team_slug, 'review_student_ideas'));
  elsif p_kind = 'pitch' then
    return query select pr.email,
        coalesce(nullif(pr.profile->>'displayName', ''), nullif(pr.name, ''), split_part(pr.email, '@', 1)),
        left(split_part(p.body, E'\n', 1), 140), p.team_slug
      from public.product_pitches p join public.profiles pr on pr.id = p.by_user
      where p.id = p_id and public.has_perm(p.team_slug, 'edit');
  end if;
end $$;

revoke execute on function public.ideas_public_status(text), public.ideas_net() from public, anon, authenticated;
revoke execute on function public.ideas_board(text), public.ideas_submit(text,text,text,text,text,text,text),
                           public.ideas_vote(uuid,text), public.ideas_my_votes(text,text), public.ideas_mine(uuid[]),
                           public.student_idea_set(uuid,text,text,text,text), public.link_pitch(uuid,text,text),
                           public.pitch_submit(text,text,boolean), public.my_pitches(text,uuid[]),
                           public.idea_mail_target(text,uuid) from public;
grant execute on function public.ideas_board(text), public.ideas_submit(text,text,text,text,text,text,text),
                          public.ideas_vote(uuid,text), public.ideas_my_votes(text,text), public.ideas_mine(uuid[])
  to anon, authenticated;
grant execute on function public.student_idea_set(uuid,text,text,text,text), public.link_pitch(uuid,text,text),
                          public.pitch_submit(text,text,boolean), public.my_pitches(text,uuid[]),
                          public.idea_mail_target(text,uuid) to authenticated;

commit;
