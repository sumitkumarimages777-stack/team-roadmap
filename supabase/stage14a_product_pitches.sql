-- =====================================================================
-- STAGE 14a — "Pitch a product idea" (the challenge card on Ideation)
--
-- WHAT THIS DOES, in plain words:
--   * product_pitches: an inbox for product ideas anyone in the team sends
--     from the card at the bottom of Social Media → Ideation.
--   * Sending goes only through submit_product_pitch(). If the person picks
--     "anonymous", the row has NO user and NO name — the database never
--     records who sent it. With their name, it keeps their id and name so
--     the team can celebrate them.
--   * claim_product_pitches(): someone who can edit (the app calls it on
--     load) takes the new pitches in one go and files them into the product
--     space's "All ideas" — each pitch is taken exactly once.
--   * Nobody reads the inbox directly from the browser.
--
-- SAFETY: one new table and two functions. Deletes nothing.
-- =====================================================================

begin;

create table public.product_pitches (
  id          uuid primary key default gen_random_uuid(),
  team_slug   text not null references public.teams(slug) on delete cascade on update cascade,
  body        text not null check (length(trim(body)) between 1 and 4000),
  by_user     uuid references auth.users(id) on delete set null,   -- null = anonymous
  by_name     text,                                                -- null = anonymous
  source      text not null default 'social-ideation' check (source ~ '^[a-z-]{1,40}$'),
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz
);
create index product_pitches_new_idx on public.product_pitches(team_slug) where claimed_at is null;

alter table public.product_pitches enable row level security;
revoke all on public.product_pitches from anon, authenticated;   -- functions only

create function public.submit_product_pitch(p_team text, p_body text, p_anonymous boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_name text;
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
          case when p_anonymous then null else v_name end);
end $$;

create function public.claim_product_pitches(p_team text) returns setof public.product_pitches
language sql security definer set search_path = '' as $$
  update public.product_pitches set claimed_at = now()
  where team_slug = p_team and claimed_at is null and public.has_perm(p_team, 'edit')
  returning *
$$;

revoke execute on function public.submit_product_pitch(text, text, boolean), public.claim_product_pitches(text) from public, anon;
grant execute on function public.submit_product_pitch(text, text, boolean), public.claim_product_pitches(text) to authenticated;

commit;
