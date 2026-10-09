-- =====================================================================
-- STAGE 15c — editable idea emails (Administration → ✉️ Idea emails)
--
-- WHAT THIS DOES, in plain words:
--   * idea_email_templates: for each moment an idea email goes out, the
--     team's own subject and text, and whether to send it at all.
--       key       thanks | approved | review | planned | progress | done |
--                 declined | message
--       audience  student (tools.dubuddy.in/ideas) | team (teammates' pitches)
--     Placeholders filled in when sending: {name} {idea} {status} {link} {message}
--     No row = the built-in text in the idea-mail function.
--   * Roles with "Review student ideas" read and change them. The idea-mail
--     function reads them when it sends.
--
-- SAFETY: one new table. Deletes nothing.
-- =====================================================================

create table public.idea_email_templates (
  team_slug  text not null references public.teams(slug) on delete cascade on update cascade,
  key        text not null check (key in ('thanks','approved','review','planned','progress','done','declined','message')),
  audience   text not null check (audience in ('student','team')),
  enabled    boolean not null default true,
  subject    text not null check (length(trim(subject)) between 1 and 200),
  body       text not null check (length(trim(body)) between 1 and 5000),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references auth.users(id) on delete set null,
  primary key (team_slug, key, audience)
);
alter table public.idea_email_templates enable row level security;
revoke all on public.idea_email_templates from anon, authenticated;
grant select, insert, update on public.idea_email_templates to authenticated;
create policy "idea email editors read" on public.idea_email_templates
  for select to authenticated using (public.has_perm(team_slug, 'review_student_ideas'));
create policy "idea email editors add" on public.idea_email_templates
  for insert to authenticated with check (public.has_perm(team_slug, 'review_student_ideas'));
create policy "idea email editors change" on public.idea_email_templates
  for update to authenticated
  using (public.has_perm(team_slug, 'review_student_ideas'))
  with check (public.has_perm(team_slug, 'review_student_ideas'));
