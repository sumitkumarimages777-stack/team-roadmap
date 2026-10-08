// =====================================================================
// STAGE 7b — "sync-social" Edge Function (Cyberflow team app)
//
// WHY THIS EXISTS: pulls the Social Media numbers from YouTube (Instagram
// next) so nobody types them in by hand. Writes into social_snapshots and
// social_posts (stage 7a). The browser can only read those tables.
//
// WHO CAN RUN IT:
//   * the daily timer (pg_cron, stage 7a) — sends the private x-cron-key;
//   * any signed-in member of the team ("Sync now" button). A sync started
//     less than 10 minutes after the last one is skipped, to save quota.
//
// SECRETS (Supabase -> Edge Functions -> Secrets):
//   YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN — from Google Cloud and
//   the OAuth Playground (read-only YouTube + YouTube Analytics scopes).
//
// HOW TO DEPLOY: name it exactly  sync-social , "Verify JWT" OFF (this code
// checks the caller itself, like manage-people).
// =====================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || SERVICE_KEY;
const MIN_GAP_MS = 10 * 60 * 1000;
const MAX_VIDEOS = 500;
const HISTORY_DAYS = 120;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
};
function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

const ymd = (d) => d.toISOString().slice(0, 10);
const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

// ISO 8601 duration (PT1H2M3S) -> seconds
function seconds(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return null;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

async function googleToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("YT_CLIENT_ID") || "",
      client_secret: Deno.env.get("YT_CLIENT_SECRET") || "",
      refresh_token: Deno.env.get("YT_REFRESH_TOKEN") || "",
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error("Google sign-in failed: " + (body.error_description || body.error || res.status));
  return body.access_token;
}

async function gget(token, url, params) {
  const res = await fetch(url + "?" + new URLSearchParams(params), { headers: { Authorization: "Bearer " + token } });
  const body = await res.json();
  if (!res.ok) throw new Error((body.error && body.error.message) || "YouTube error " + res.status);
  return body;
}

// one Analytics report as [{column: value}]
async function report(token, params) {
  const r = await gget(token, "https://youtubeanalytics.googleapis.com/v2/reports", { ids: "channel==MINE", ...params });
  const cols = (r.columnHeaders || []).map((h) => h.name);
  return (r.rows || []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

async function syncYouTube(admin, team, cfg) {
  const token = await googleToken();
  const DATA = "https://www.googleapis.com/youtube/v3";
  const notes = [];

  const ch = await gget(token, DATA + "/channels", { part: "snippet,statistics,contentDetails", mine: "true" });
  const channel = ch.items && ch.items[0];
  if (!channel) throw new Error("This Google account has no YouTube channel. Sign in to the Playground as the channel owner.");
  const stats = channel.statistics;
  const today = new Date();

  // signed in to a different channel than last time: its old numbers don't belong here
  if (cfg.youtube_channel_id !== channel.id) {
    await admin.from("social_posts").delete().eq("team_slug", team).eq("platform", "youtube");
    await admin.from("social_snapshots").delete().eq("team_slug", team).eq("platform", "youtube");
    await admin.from("social_sync_config").update({ youtube_channel_id: channel.id }).eq("id", 1);
    if (cfg.youtube_channel_id) notes.push("YouTube channel changed: cleared the previous channel's numbers.");
  }

  // --- every upload (newest first), then their details in batches of 50
  const ids = [];
  let page = "";
  do {
    const pl = await gget(token, DATA + "/playlistItems", {
      part: "contentDetails", maxResults: "50", playlistId: channel.contentDetails.relatedPlaylists.uploads,
      ...(page ? { pageToken: page } : {}),
    });
    for (const it of pl.items || []) ids.push(it.contentDetails.videoId);
    page = pl.nextPageToken || "";
  } while (page && ids.length < MAX_VIDEOS);

  const posts = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const v = await gget(token, DATA + "/videos", { part: "snippet,statistics,contentDetails,status", id: ids.slice(i, i + 50).join(",") });
    for (const it of v.items || []) {
      if (it.status && it.status.privacyStatus !== "public") continue;
      const dur = seconds(it.contentDetails.duration);
      posts.set(it.id, {
        team_slug: team, platform: "youtube", external_id: it.id,
        title: it.snippet.title,
        url: (dur !== null && dur <= 180 ? "https://www.youtube.com/shorts/" : "https://www.youtube.com/watch?v=") + it.id,
        thumbnail: (it.snippet.thumbnails && (it.snippet.thumbnails.medium || it.snippet.thumbnails.default) || {}).url || null,
        post_type: dur !== null && dur <= 180 ? "Short" : "Long video",
        published_at: it.snippet.publishedAt, duration_s: dur,
        views: num(it.statistics.viewCount), likes: num(it.statistics.likeCount),
        comments: num(it.statistics.commentCount),
        shares: null, watch_minutes: null, avg_view_s: null, avg_view_pct: null, impressions: null, ctr_pct: null,
        updated_at: new Date().toISOString(),
      });
    }
  }

  // --- lifetime per-video analytics: shares, watch time, retention. Asked for by
  // video id, 50 at a time — a "top videos" report would skip the newer ones.
  try {
    const all = [...posts.keys()];
    for (let i = 0; i < all.length; i += 50) {
      const rows = await report(token, {
        startDate: "2005-04-23", endDate: ymd(today), dimensions: "video", filters: "video==" + all.slice(i, i + 50).join(","),
        metrics: "views,shares,estimatedMinutesWatched,averageViewDuration,averageViewPercentage",
      });
      for (const r of rows) {
        const p = posts.get(r.video);
        if (!p) continue;
        p.shares = num(r.shares);
        p.watch_minutes = num(r.estimatedMinutesWatched);
        p.avg_view_s = num(r.averageViewDuration);
        p.avg_view_pct = num(r.averageViewPercentage);
      }
    }
  } catch (e) { notes.push("Shares/watch time not available: " + e.message); }

  // Thumbnail impressions / CTR: YouTube Analytics does not offer them per
  // video ("query is not supported"), so ctr_pct stays empty (Studio only).

  if (posts.size) {
    const { error } = await admin.from("social_posts").upsert([...posts.values()]);
    if (error) throw new Error("Saving posts failed: " + error.message);
  }

  // --- follower history: today's count, walked back with daily gained/lost
  const current = num(stats.subscriberCount);
  const snaps = [{ team_slug: team, platform: "youtube", day: ymd(today), followers: current,
    total_views: num(stats.viewCount), post_count: num(stats.videoCount), updated_at: new Date().toISOString() }];
  try {
    const start = new Date(today.getTime() - HISTORY_DAYS * 86400000);
    const rows = await report(token, {
      startDate: ymd(start), endDate: ymd(today), dimensions: "day", sort: "-day",
      metrics: "subscribersGained,subscribersLost",
    });
    // the count at the end of day D = current minus the net change on every day after D
    let count = current;
    for (const r of rows) {
      if (r.day >= ymd(today)) { count -= (num(r.subscribersGained) || 0) - (num(r.subscribersLost) || 0); continue; }
      snaps.push({ team_slug: team, platform: "youtube", day: r.day, followers: count, updated_at: new Date().toISOString() });
      count -= (num(r.subscribersGained) || 0) - (num(r.subscribersLost) || 0);
    }
  } catch (e) { notes.push("Follower history not available: " + e.message); }

  // keep real past snapshots: only fill days we have never recorded
  const { data: have } = await admin.from("social_snapshots").select("day")
    .eq("team_slug", team).eq("platform", "youtube").lt("day", ymd(today));
  const known = new Set((have || []).map((r) => r.day));
  const toSave = snaps.filter((s) => s.day === ymd(today) || !known.has(s.day));
  const { error: sErr } = await admin.from("social_snapshots").upsert(toSave);
  if (sErr) throw new Error("Saving followers failed: " + sErr.message);

  return { channel: channel.snippet.title, followers: current, videos: posts.size, history_days: toSave.length - 1, notes };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "POST only" });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: cfg, error: cfgErr } = await admin.from("social_sync_config").select("*").eq("id", 1).single();
  if (cfgErr || !cfg) return reply(500, { error: "Run stage7a_social_sync.sql first." });
  const team = cfg.team_slug;

  // --- who is calling: the daily timer, or a signed-in team member
  const cronKey = req.headers.get("x-cron-key");
  if (cronKey) {
    if (cronKey !== cfg.cron_key) return reply(401, { error: "Wrong key." });
  } else {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return reply(401, { error: "Sign in first." });
    const caller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: "Bearer " + token } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: ok } = await caller.rpc("has_role", { team, min_role: "viewer" });
    if (!ok) return reply(403, { error: "Only team members can sync." });
    if (cfg.last_sync && Date.now() - new Date(cfg.last_sync).getTime() < MIN_GAP_MS) {
      return reply(200, { skipped: true, last_sync: cfg.last_sync, last_result: cfg.last_result });
    }
  }

  const result = { youtube: null };
  try {
    result.youtube = await syncYouTube(admin, team, cfg);
  } catch (e) {
    result.youtube = { error: e.message };
  }
  const now = new Date().toISOString();
  await admin.from("social_sync_config").update({ last_sync: now, last_result: result }).eq("id", 1);
  return reply(result.youtube && result.youtube.error ? 502 : 200, { last_sync: now, ...result });
});
