// =====================================================================
// STAGE 6b — "manage-games" Edge Function (Cyberflow team app)
//
// WHY THIS EXISTS: game files live in a private storage folder ("games") that
// only this function can read or write, using Supabase's secret key (provided
// automatically on the server, never in the web page). Every action checks the
// caller's permissions first, through the database rules from stage 6a.
//
//   save_game     roles with "Create games": create a game or save a new
//                 version of your own game (HTML file, max 3 MB). Saving an
//                 approved game keeps the approved version playable until the
//                 new one is approved.
//   submit_game   send your draft for review (emails the super-admin).
//   game_file     the HTML of a game: the live version for anyone allowed to
//                 play it; any version for its creator and the super-admin.
//   review_game   super-admin: approve, or send back with a note (emails the
//                 creator).
//   retire_game   super-admin: hide / show a game.
//   set_path      super-admin: the 10 Let's Play slots (company games only).
//
// HOW TO DEPLOY: Supabase -> Edge Functions -> Deploy a new function -> Via
// Editor. Name it exactly  manage-games  (set the name BEFORE deploying),
// paste this file, Deploy. Then Settings -> turn "Verify JWT" OFF (this code
// checks the sign-in itself, like manage-people). Uses the same SMTP_USER /
// SMTP_PASS secrets as manage-people for emails.
// =====================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || SERVICE_KEY;
const BUCKET = "games";
const MAX_BYTES = 3 * 1024 * 1024;
const LEVELS = ["company", "team", "department"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return reply(401, { error: "Sign in first." });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: "Bearer " + token } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who || !who.user) return reply(401, { error: "Sign in first." });
  const me = who.user;

  let body;
  try { body = await req.json(); } catch (_) { return reply(400, { error: "Bad request." }); }
  try {
    if (body.action === "save_game") return reply(200, await saveGame(caller, admin, me, body));
    if (body.action === "submit_game") return reply(200, await submitGame(caller, admin, me, body));
    if (body.action === "game_file") return reply(200, await gameFile(caller, admin, me, body));
    if (body.action === "review_game") return reply(200, await reviewGame(caller, admin, me, body));
    if (body.action === "retire_game") return reply(200, await retireGame(caller, admin, body));
    if (body.action === "set_path") return reply(200, await setPath(caller, admin, body));
    return reply(400, { error: "Unknown action." });
  } catch (e) {
    return reply(400, { error: (e && e.message) || String(e) });
  }
});

// ---------- helpers ------------------------------------------------------
async function rpc(client, fn, args) {
  const { data, error } = await client.rpc(fn, args || {});
  if (error) throw new Error(error.message);
  return data;
}
async function isSuper(caller) { return !!(await rpc(caller, "is_super")); }
function filePath(id, v) { return id + "/v" + v + ".html"; }
function clean(v, max) { return String(v == null ? "" : v).trim().slice(0, max); }
async function loadGame(admin, id) {
  const { data, error } = await admin.from("games").select("*").eq("id", String(id || "")).maybeSingle();
  if (error || !data) throw new Error("That game doesn't exist.");
  return data;
}

// email (Zoho Mail over secure SMTP, port 465 — same secrets as manage-people)
function esc(v) { return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
async function sendMail(to, subject, paras) {
  const user = Deno.env.get("SMTP_USER"), pass = Deno.env.get("SMTP_PASS");
  if (!user || !pass || !to) return "email isn't set up";
  const link = Deno.env.get("APP_URL") || "https://tools.dubuddy.in/";
  try {
    const mailer = nodemailer.createTransport({ host: Deno.env.get("SMTP_HOST") || "smtp.zoho.in", port: 465, secure: true, auth: { user, pass } });
    await mailer.sendMail({
      from: Deno.env.get("MAIL_FROM") || ("Dubuddy Team <" + user + ">"), to, subject,
      text: paras.join("\n\n") + "\n\nOpen the team app: " + link + "\n",
      html: '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#17233A;max-width:520px">'
        + paras.map((x) => "<p>" + esc(x) + "</p>").join("") + '<p><a href="' + esc(link) + '">Open the team app</a></p></div>',
    });
    return null;
  } catch (e) { return (e && e.message) || String(e); }
}
async function profileOf(admin, id) {
  if (!id) return null;
  const { data } = await admin.from("profiles").select("email,name,profile").eq("id", id).maybeSingle();
  return data || null;
}
function nameOf(p) { return (p && p.profile && p.profile.displayName) || (p && p.name) || (p && p.email) || "someone"; }

// ---------- save_game ------------------------------------------------------
// body: { action, team, id?, title, emoji, tagline, takeaway, level, department_id?, html? }
async function saveGame(caller, admin, me, b) {
  const team = clean(b.team, 60);
  if (!(await rpc(caller, "has_perm", { team, perm: "create_games" }))) throw new Error("Your role can't create games in this team.");
  const title = clean(b.title, 80);
  if (!title) throw new Error("Give the game a name.");
  const level = LEVELS.includes(b.level) ? b.level : "company";
  const department_id = level === "department" ? clean(b.department_id, 80) : null;
  if (level === "department" && !department_id) throw new Error("Pick the department this game is for.");
  const html = typeof b.html === "string" ? b.html : null;
  const bytes = html === null ? 0 : new TextEncoder().encode(html).length;
  if (bytes > MAX_BYTES) throw new Error("The game file is " + (bytes / 1048576).toFixed(1) + " MB — the limit is 3 MB.");
  if (html !== null && !/<\s*(html|body|script|canvas|div)/i.test(html)) throw new Error("That doesn't look like an HTML game file.");

  const fields = {
    title, emoji: clean(b.emoji, 8) || "🎮", tagline: clean(b.tagline, 140), takeaway: clean(b.takeaway, 400),
    level, team_slug: team, department_id, updated_at: new Date().toISOString(),
  };
  let game;
  if (b.id) {
    game = await loadGame(admin, b.id);
    if (game.creator !== me.id) throw new Error("You can only change games you created.");
    if (game.kind !== "html") throw new Error("Built-in games can't be edited here.");
    if (game.status === "submitted") throw new Error("This game is waiting for review. You can change it after it's reviewed.");
    // once a game has been approved, its name, level etc. are locked (they're live);
    // the creator can still upload a new version, which goes through review again
    const upd = game.live_version ? { updated_at: fields.updated_at } : { ...fields };
    if (game.live_version && html === null) throw new Error("This game is live. To change it, upload a new version (it will be reviewed again).");
    if (html !== null) { upd.version = game.version + 1; upd.file_size = bytes; upd.status = "draft"; upd.review_note = null; }
    else if (game.status !== "approved") upd.status = game.status === "sent_back" ? "sent_back" : "draft";
    if (html !== null) await upload(admin, game.id, upd.version, html);
    const { data, error } = await admin.from("games").update(upd).eq("id", game.id).select("*").single();
    if (error) throw new Error(error.message);
    game = data;
  } else {
    if (html === null) throw new Error("Add the game's HTML file.");
    const { data, error } = await admin.from("games").insert({ ...fields, kind: "html", status: "draft", version: 1, file_size: bytes, creator: me.id }).select("*").single();
    if (error) throw new Error(error.message);
    try { await upload(admin, data.id, 1, html); }
    catch (e) { await admin.from("games").delete().eq("id", data.id); throw e; }   // nothing half-made
    game = data;
  }
  return { ok: true, game };
}
async function upload(admin, id, v, html) {
  const { error } = await admin.storage.from(BUCKET).upload(filePath(id, v), new Blob([html], { type: "text/html" }), { upsert: true, contentType: "text/html" });
  if (error) throw new Error("Couldn't store the game file: " + error.message);
}

// ---------- submit_game ----------------------------------------------------
async function submitGame(caller, admin, me, b) {
  const game = await loadGame(admin, b.id);
  if (game.creator !== me.id) throw new Error("You can only submit games you created.");
  if (!["draft", "sent_back"].includes(game.status)) throw new Error("This game is already " + game.status.replace("_", " ") + ".");
  const { error } = await admin.from("games").update({ status: "submitted", updated_at: new Date().toISOString() }).eq("id", game.id);
  if (error) throw new Error(error.message);
  // tell the super-admin(s)
  const { data: supers } = await admin.from("profiles").select("email").eq("is_super", true);
  const author = await profileOf(admin, me.id);
  for (const s of (supers || [])) {
    await sendMail(s.email, "New game to review: " + game.title,
      [nameOf(author) + " submitted a game for review: “" + game.title + "” (" + game.level + " level).",
       "Open Administration → Review games to play it and approve or send it back."]);
  }
  return { ok: true };
}

// ---------- game_file -------------------------------------------------------
// body: { action, id, version? }
async function gameFile(caller, admin, me, b) {
  const game = await loadGame(admin, b.id);
  if (game.kind !== "html") throw new Error("Built-in games don't have a file.");
  const sup = await isSuper(caller);
  const mine = game.creator === me.id;
  let v = Number(b.version) || 0;
  if (sup || mine) { if (!v) v = game.version; }
  else {
    if (!(await rpc(caller, "can_play_game", { p_id: game.id }))) throw new Error("You can't play this game.");
    v = game.live_version;   // players only ever get the approved version
  }
  if (!v || v < 1 || v > game.version) throw new Error("No such version.");
  const { data, error } = await admin.storage.from(BUCKET).download(filePath(game.id, v));
  if (error || !data) throw new Error("Couldn't load the game file.");
  return { ok: true, version: v, html: await data.text() };
}

// ---------- review_game (super-admin) ---------------------------------------
// body: { action, id, decision: "approve" | "send_back", note? }
async function reviewGame(caller, admin, me, b) {
  if (!(await isSuper(caller))) throw new Error("Only the super-admin reviews games.");
  const game = await loadGame(admin, b.id);
  if (game.status !== "submitted") throw new Error("This game isn't waiting for review.");
  const note = clean(b.note, 1000) || null;
  const now = new Date().toISOString();
  const upd = b.decision === "approve"
    ? { status: "approved", live_version: game.version, review_note: note, reviewed_by: me.id, reviewed_at: now, updated_at: now }
    : { status: "sent_back", review_note: note, reviewed_by: me.id, reviewed_at: now, updated_at: now };
  if (b.decision !== "approve" && b.decision !== "send_back") throw new Error("Choose approve or send back.");
  const { error } = await admin.from("games").update(upd).eq("id", game.id).eq("status", "submitted");
  if (error) throw new Error(error.message);
  const author = await profileOf(admin, game.creator);
  let emailError = null;
  if (author) {
    emailError = b.decision === "approve"
      ? await sendMail(author.email, "Approved: your game “" + game.title + "”",
          ["Great news — your game “" + game.title + "” was approved." + (note ? " Note: " + note : ""),
           "It's now in the games library. The super-admin chooses which games appear on the Let's Play path."])
      : await sendMail(author.email, "Changes needed: your game “" + game.title + "”",
          ["Your game “" + game.title + "” was sent back with a note:", note || "(no note)",
           "Open Administration → My games to upload a new version and submit it again."]);
  }
  return { ok: true, emailed: !!author && !emailError, emailError };
}

// ---------- retire_game / set_path (super-admin) ----------------------------
async function retireGame(caller, admin, b) {
  if (!(await isSuper(caller))) throw new Error("Only the super-admin can do this.");
  const game = await loadGame(admin, b.id);
  const { error } = await admin.from("games").update({ retired: !!b.retired, updated_at: new Date().toISOString() }).eq("id", game.id);
  if (error) throw new Error(error.message);
  if (b.retired) await admin.from("game_path").update({ game_id: null }).eq("game_id", game.id);
  return { ok: true };
}
// body: { action, slots: [gameId | null, ... up to 10] }
async function setPath(caller, admin, b) {
  if (!(await isSuper(caller))) throw new Error("Only the super-admin chooses the Let's Play games.");
  const slots = (Array.isArray(b.slots) ? b.slots : []).slice(0, 10);
  const ids = slots.filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error("A game can only be in one slot.");
  if (ids.length) {
    const { data } = await admin.from("games").select("id,level,live_version,retired").in("id", ids);
    for (const id of ids) {
      const g = (data || []).find((x) => x.id === id);
      if (!g) throw new Error("A chosen game doesn't exist.");
      if (g.level !== "company") throw new Error("Only Company-level games can go on the Let's Play path.");
      if (!g.live_version || g.retired) throw new Error("Only approved, active games can go on the path.");
    }
  }
  const rows = Array.from({ length: 10 }, (_, i) => ({ slot: i + 1, game_id: slots[i] || null }));
  const { error } = await admin.from("game_path").upsert(rows, { onConflict: "slot" });
  if (error) throw new Error(error.message);
  return { ok: true };
}
