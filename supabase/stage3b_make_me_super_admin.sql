-- =====================================================================
-- STAGE 3b — make yourself the super-admin (run ONCE)
--
-- BEFORE running this, create your own login in the dashboard:
--   Authentication -> Users -> Add user -> Create new user
--   * Email: the SAME email you sign in to the team app with today
--   * Password: a strong one (this is your real password now)
--   * tick "Auto Confirm User"
--
-- THEN: replace YOUR_EMAIL_HERE below (keep the quotes), and Run.
-- It adds one row: your profile, marked super-admin. Nothing else changes.
-- If it says "0 rows", the email didn't match a login — check the spelling.
-- =====================================================================

insert into public.profiles (id, email, name, is_super)
select u.id, lower(u.email), split_part(u.email, '@', 1), true
from auth.users u
where lower(u.email) = lower(trim('YOUR_EMAIL_HERE'))
on conflict (id) do update set is_super = true;

-- Check: this should show exactly one row with is_super = true
select email, name, is_super from public.profiles where is_super;
