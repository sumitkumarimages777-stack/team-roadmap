-- =====================================================================
-- STAGE 11b — a YouTube video in a notification
--
-- WHAT THIS DOES, in plain words:
--   * Adds one optional column to team_notifications: video_id, the
--     11-character YouTube video id (from a youtube.com / youtu.be link).
--     The pop-up and the bell play that video inside the app.
--   * Only a real-looking YouTube id can be saved (letters, numbers, - _).
--
-- SAFETY: adds one empty column. Deletes nothing.
-- =====================================================================

alter table public.team_notifications
  add column video_id text check (video_id ~ '^[A-Za-z0-9_-]{11}$');
