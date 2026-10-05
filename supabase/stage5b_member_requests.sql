-- =====================================================================
-- STAGE 5b — Teammate requests (Manager asks, Owner/Admin approves)
--
-- WHAT THIS DOES, in plain words:
--   * One new table, member_requests: "please add this person to the team".
--   * Who can do what (enforced by the database):
--       - roles with "Request teammates" can send a request for their team,
--         for any role except Owner;
--       - they see their own requests (and the answer);
--       - roles with "Approve requests" see all requests of their team.
--   * Approving / rejecting happens on the server (the manage-people
--     function), because approving creates a login and sends emails.
--     The browser can't change a request's status at all.
--   * The same email can't be waiting twice for the same team.
--
-- SAFETY: creates one table and its rules. Deletes nothing.
-- HOW TO RUN: SQL Editor -> New query -> paste -> Run.
-- Expected: "Success. No rows returned".
-- =====================================================================

begin;

create table public.member_requests (
  id            uuid primary key default gen_random_uuid(),
  team_slug     text not null references public.teams(slug) on delete cascade on update cascade,
  email         text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name          text not null default '',
  role          text not null,
  note          text not null default '',
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_by  uuid default auth.uid() references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  decided_by    uuid references auth.users(id) on delete set null,
  decided_at    timestamptz,
  reason        text,
  user_id       uuid references auth.users(id) on delete set null   -- the account, once approved
);
create index member_requests_team_idx on public.member_requests(team_slug, status);
create unique index member_requests_one_pending on public.member_requests(team_slug, lower(email)) where status = 'pending';

alter table public.member_requests enable row level security;
revoke all on public.member_requests from anon;
revoke update, delete, truncate on public.member_requests from authenticated;
grant select, insert on public.member_requests to authenticated;

-- see: your own requests, or every request of a team you approve for
create policy "requesters and approvers see requests" on public.member_requests
  for select to authenticated
  using (requested_by = auth.uid() or public.has_perm(team_slug, 'approve_requests'));

-- send: only with "Request teammates", only as yourself, only a fresh pending
-- request, never for Owner, and only for a role the team actually has
create policy "requesters send requests" on public.member_requests
  for insert to authenticated
  with check (
    public.has_perm(team_slug, 'request_members')
    and requested_by = auth.uid()
    and status = 'pending'
    and decided_by is null and decided_at is null and reason is null and user_id is null
    and role <> 'owner'
    and exists (select 1 from public.team_roles r where r.team_slug = member_requests.team_slug and r.key = member_requests.role)
  );

commit;
