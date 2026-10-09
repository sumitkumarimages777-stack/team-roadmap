-- =====================================================================
-- STAGE 15b — "thank you" emails when an idea is sent
--
-- WHAT THIS DOES, in plain words:
--   * Remembers when a thank-you email went out (thanked_at), so each idea
--     gets at most ONE, and only within 30 minutes of being sent.
--   * idea_thanks_target(kind, id): returns where to send the thank-you and
--     marks it sent. Students (signed out) can only trigger it for their own
--     fresh idea that has an email; a teammate only for their own named pitch.
--     The idea-mail function calls it.
--
-- SAFETY: two new columns and one function. Deletes nothing.
-- =====================================================================

alter table public.student_ideas   add column thanked_at timestamptz;
alter table public.product_pitches add column thanked_at timestamptz;

create function public.idea_thanks_target(p_kind text, p_id uuid)
returns table (email text, name text, title text, team text)
language plpgsql security definer set search_path = '' as $$
begin
  if p_kind = 'student' then
    return query
      update public.student_ideas i set thanked_at = now()
      where i.id = p_id and i.thanked_at is null and i.email is not null
        and i.created_at > now() - interval '30 minutes'
      returning i.email, coalesce(i.name, ''), i.title, i.team_slug;
  elsif p_kind = 'pitch' then
    return query
      with p as (
        update public.product_pitches pp set thanked_at = now()
        where pp.id = p_id and pp.thanked_at is null and pp.by_user = auth.uid()
          and pp.created_at > now() - interval '30 minutes'
        returning pp.by_user, pp.body, pp.team_slug)
      select pr.email,
             coalesce(nullif(pr.profile->>'displayName', ''), nullif(pr.name, ''), split_part(pr.email, '@', 1)),
             left(split_part(p.body, E'\n', 1), 140), p.team_slug
      from p join public.profiles pr on pr.id = p.by_user;
  end if;
end $$;

revoke execute on function public.idea_thanks_target(text, uuid) from public;
grant execute on function public.idea_thanks_target(text, uuid) to anon, authenticated;
