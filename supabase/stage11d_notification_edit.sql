-- =====================================================================
-- STAGE 11d — senders can edit a notification after sending it
--
-- WHAT THIS DOES, in plain words:
--   * People with "Send notifications" can now change a sent message:
--     who it's for, title, text, video, bell / pop-up / banner settings.
--     The same rule as before decides who may (policy "senders stop
--     notifications" checks send_notifications for that team).
--   * Still fixed after sending: the team, who sent it, and when.
--   * What people already did (read, Got it, hidden) is kept.
--
-- SAFETY: only widens which columns senders may update. Deletes nothing.
-- =====================================================================

grant update (title, body, video_id, audience, recipients,
              bell, popup, popup_rule, popup_times, popup_gap, show_until,
              place, place_until, stopped)
  on public.team_notifications to authenticated;
