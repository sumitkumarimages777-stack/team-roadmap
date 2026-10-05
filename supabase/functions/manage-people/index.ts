// =====================================================================
// STAGE 3b — "manage-people" Edge Function (Cyberflow team app)
//
// WHY THIS EXISTS: creating a login or setting someone's password needs
// Supabase's secret "service role" key. That key must never be in the web
// page, so these three jobs run here, on Supabase's server, where the key is
// provided automatically and nobody can read it.
//
//   add_person      Owner/Admin adds someone to their team (makes the login
//                   if it doesn't exist yet). Same rules as index.html.
//   reset_password  Owner/Admin gives a teammate a new random temporary
//                   password (replaces the old fixed "welcome").
//   import_users    Super-admin only, run once: copies the existing teams and
//                   people from JSONBin into Supabase.
//   email_login     Owner/Admin: gives a teammate a new temporary password and
//                   EMAILS it to them (with the sign-in link). The admin never
//                   sees the password. Needs the email settings below.
//   fresh_temp_passwords  Super-admin only: gives a NEW random temporary
//                   password to everyone who hasn't set their own password yet
//                   (so any temporary password seen earlier stops working).
//
// Every request must carry the caller's Supabase login. The role checks use
// the same database functions as everything else (has_role, is_super,
// set_member_role), so the rules live in one place: stage3a SQL.
//
// EMAIL SETTINGS (for email_login), in Supabase -> Edge Functions -> Secrets.
// Emails are sent from a Zoho Mail mailbox over secure SMTP (port 465):
//   SMTP_USER        the mailbox, e.g.  sumitkumar@dubuddy.in
//   SMTP_PASS        a Zoho APP password for that mailbox (not the real password)
//   SMTP_HOST        optional; defaults to smtp.zoho.in (India). Use smtp.zoho.com for zoho.com accounts.
//   MAIL_FROM        optional; defaults to  Dubuddy Team <SMTP_USER>
//   APP_URL          optional; defaults to https://tools.dubuddy.in/
//
// HOW TO DEPLOY: Supabase dashboard -> Edge Functions -> Deploy a new
// function -> Via Editor -> name it exactly  manage-people  -> paste this
// whole file -> Deploy. Leave "Verify JWT" ON.
// =====================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// the public key: requests made with it carry only the caller's own rights
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || SERVICE_KEY;
const ROLES = ["owner", "admin", "editor", "commenter", "viewer"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "POST only" });

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return reply(401, { error: "Sign in first." });

  // admin: full power, used only after the checks below pass.
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // caller: acts AS the signed-in person, so database rules see who they are.
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
    if (body.action === "add_person") return reply(200, await addPerson(caller, admin, body));
    if (body.action === "reset_password") return reply(200, await resetPassword(caller, admin, me, body));
    if (body.action === "import_users") return reply(200, await importUsers(caller, admin, body));
    if (body.action === "fresh_temp_passwords") return reply(200, await freshTempPasswords(caller, admin));
    if (body.action === "email_login") return reply(200, await emailLogin(caller, admin, me, body));
    return reply(400, { error: "Unknown action." });
  } catch (e) {
    return reply(400, { error: (e && e.message) || String(e) });
  }
});

// ---------- helpers ----------------------------------------------------

async function rpc(client, fn, args) {
  const { data, error } = await client.rpc(fn, args || {});
  if (error) throw new Error(error.message);
  return data;
}

function cleanEmail(v) { return String(v || "").toLowerCase().trim(); }
function cleanUsername(v) { const u = String(v || "").toLowerCase().trim(); return u || null; }
function validEmail(v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v); }

// 12 characters, no look-alikes (0/O, 1/l/I), from the browser-grade random source.
function tempPassword() {
  const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

// Find a login by email, even if it has no profile yet (e.g. made by hand
// in the dashboard). Fine for a team-sized number of accounts.
async function findLogin(admin, email) {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const hit = data.users.find((u) => cleanEmail(u.email) === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function usernameTakenByOther(admin, username, email) {
  if (!username) return false;
  const { data, error } = await admin.from("profiles").select("email").eq("username", username).maybeSingle();
  if (error) throw new Error(error.message);
  return !!data && data.email !== email;
}

// Make sure this person has a login + profile. Returns
// { id, created, tempPassword } — tempPassword only when we made one up.
async function ensureAccount(admin, p) {
  const email = cleanEmail(p.email);
  if (!validEmail(email)) throw new Error("Enter a valid email.");

  const { data: existing, error: exErr } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  if (exErr) throw new Error(exErr.message);
  if (existing) return { id: existing.id, created: false, tempPassword: null };

  const given = String(p.password || "").trim();
  const pw = given || tempPassword();
  let userId, madeLogin = false;
  const { data: made, error: makeErr } = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
  if (made && made.user) { userId = made.user.id; madeLogin = true; }
  else {
    const found = await findLogin(admin, email);
    if (!found) throw new Error("Couldn't create the account for " + email + ": " + (makeErr ? makeErr.message : "unknown error"));
    userId = found.id;   // login already existed; keep its password
  }

  const { error: profErr } = await admin.from("profiles").insert({
    id: userId,
    email,
    name: String(p.name || "").trim() || email.split("@")[0],
    username: cleanUsername(p.username),
    is_super: !!p.is_super,
    must_change_pw: madeLogin && !given,
    profile: (p.profile && typeof p.profile === "object") ? p.profile : {},
  });
  if (profErr) {
    if (madeLogin) await admin.auth.admin.deleteUser(userId);   // undo, so nothing is left half-made
    throw new Error(profErr.code === "23505" ? "That username is already taken." : profErr.message);
  }
  return { id: userId, created: true, tempPassword: madeLogin && !given ? pw : null };
}

// ---------- add_person -------------------------------------------------
// body: { action, team, email, name?, username?, role, password? }
async function addPerson(caller, admin, b) {
  const team = String(b.team || "");
  const role = String(b.role || "");
  const email = cleanEmail(b.email);
  const username = cleanUsername(b.username);
  if (!ROLES.includes(role)) throw new Error("Pick a role.");
  if (!(await rpc(caller, "has_role", { team, min_role: "admin" }))) throw new Error("Only Owners and Admins can manage people.");
  if (role === "owner" && !(await rpc(caller, "is_super"))) throw new Error("Only a super-admin can make someone an Owner.");
  if (await usernameTakenByOther(admin, username, email)) throw new Error("That username is already taken.");

  const acct = await ensureAccount(admin, { email, name: b.name, username, password: b.password });
  if (!acct.created) {
    // existing person: same as the old app — a typed name/username updates theirs
    const upd = {};
    if (String(b.name || "").trim()) upd.name = String(b.name).trim();
    if (username) upd.username = username;
    if (Object.keys(upd).length) {
      const { error } = await admin.from("profiles").update(upd).eq("id", acct.id);
      if (error) throw new Error(error.message);
    }
  }
  // the database applies the role rules again here, as the caller
  await rpc(caller, "set_member_role", { p_team: team, p_user: acct.id, p_role: role });
  return { ok: true, user_id: acct.id, email, created: acct.created, tempPassword: acct.tempPassword };
}

// ---------- reset_password ---------------------------------------------
// body: { action, team, user_id }
async function resetPassword(caller, admin, me, b) {
  const team = String(b.team || "");
  const userId = String(b.user_id || "");
  await checkMayReset(caller, admin, me, team, userId);
  const pw = await setTempPassword(admin, userId);
  return { ok: true, tempPassword: pw };
}

// Owner/Admin of the team, not yourself, and only a super-admin may touch an Owner or a super-admin.
async function checkMayReset(caller, admin, me, team, userId) {
  if (!(await rpc(caller, "has_role", { team, min_role: "admin" }))) throw new Error("Only Owners and Admins can manage people.");
  if (userId === me.id) throw new Error("Use “Change password” for your own account.");

  const iAmSuper = await rpc(caller, "is_super");
  const { data: m, error: mErr } = await admin.from("memberships").select("role").eq("team_slug", team).eq("user_id", userId).maybeSingle();
  if (mErr) throw new Error(mErr.message);
  if (!m) throw new Error("That person isn't in this team.");
  if (m.role === "owner" && !iAmSuper) throw new Error("Only a super-admin can reset an Owner's password.");
  const { data: target } = await admin.from("profiles").select("is_super").eq("id", userId).maybeSingle();
  if (target && target.is_super && !iAmSuper) throw new Error("Only a super-admin can reset a super-admin's password.");
}

async function setTempPassword(admin, userId) {
  const pw = tempPassword();
  const { error: upErr } = await admin.auth.admin.updateUserById(userId, { password: pw });
  if (upErr) throw new Error(upErr.message);
  const { error: flagErr } = await admin.from("profiles").update({ must_change_pw: true }).eq("id", userId);
  if (flagErr) throw new Error(flagErr.message);
  return pw;
}

// ---------- import_users (one-time, super-admin) -----------------------
// body: { action, teams: [{slug, name}], users: [{email, name, username, super, teams:{slug: role}, profile}] }
// Safe to run twice: people and teams that already exist are left as they are
// (no passwords changed); only missing ones are added.
async function importUsers(caller, admin, b) {
  if (!(await rpc(caller, "is_super"))) throw new Error("Only a super-admin can import users.");

  const teams = Array.isArray(b.teams) ? b.teams : [];
  for (const t of teams) {
    const slug = String(t.slug || "");
    const { error } = await admin.from("teams").upsert(
      { slug, name: String(t.name || slug) },
      { onConflict: "slug", ignoreDuplicates: true },
    );
    if (error) throw new Error("Team “" + slug + "”: " + error.message);
  }
  const { data: known } = await admin.from("teams").select("slug");
  const knownSlugs = new Set((known || []).map((t) => t.slug));

  const results = [];
  for (const u of (Array.isArray(b.users) ? b.users : [])) {
    const email = cleanEmail(u.email);
    try {
      const acct = await ensureAccount(admin, {
        email, name: u.name, username: u.username, is_super: !!u.super, profile: u.profile,
      });
      const rows = Object.entries(u.teams || {})
        .filter(([slug, role]) => knownSlugs.has(slug) && ROLES.includes(role))
        .map(([slug, role]) => ({ team_slug: slug, user_id: acct.id, role }));
      if (rows.length) {
        const { error } = await admin.from("memberships").upsert(rows, { onConflict: "team_slug,user_id", ignoreDuplicates: true });
        if (error) throw new Error(error.message);
      }
      results.push({ email, created: acct.created, tempPassword: acct.tempPassword, teams: rows.length });
    } catch (e) {
      results.push({ email, error: (e && e.message) || String(e) });
    }
  }
  return { ok: true, results };
}

// ---------- fresh_temp_passwords (super-admin) ---------------------------
// Everyone still on a temporary password (must_change_pw = true) gets a new one.
// People who already chose their own password are not touched.
async function freshTempPasswords(caller, admin) {
  if (!(await rpc(caller, "is_super"))) throw new Error("Only a super-admin can do this.");
  const { data, error } = await admin.from("profiles").select("id,email").eq("must_change_pw", true);
  if (error) throw new Error(error.message);
  const results = [];
  for (const p of (data || [])) {
    const pw = tempPassword();
    const { error: upErr } = await admin.auth.admin.updateUserById(p.id, { password: pw });
    results.push(upErr ? { email: p.email, error: upErr.message } : { email: p.email, tempPassword: pw });
  }
  return { ok: true, results };
}

// ---------- email_login ----------------------------------------------------
// body: { action, team, user_id }
// Makes a new temporary password and emails it, with the sign-in link, to the
// person themselves. If the email can't be sent, the password is returned to
// the admin instead (with the reason), so nobody is left locked out.
async function emailLogin(caller, admin, me, b) {
  const team = String(b.team || "");
  const userId = String(b.user_id || "");
  const smtpUser = Deno.env.get("SMTP_USER");
  const smtpPass = Deno.env.get("SMTP_PASS");
  if (!smtpUser || !smtpPass) throw new Error("Email isn't set up yet (SMTP_USER and SMTP_PASS are missing in Supabase Edge Function secrets).");
  const from = Deno.env.get("MAIL_FROM") || ("Dubuddy Team <" + smtpUser + ">");
  await checkMayReset(caller, admin, me, team, userId);

  const { data: p, error: pErr } = await admin.from("profiles").select("email,name,profile").eq("id", userId).maybeSingle();
  if (pErr || !p) throw new Error("Couldn't find that person.");
  const { data: t } = await admin.from("teams").select("name").eq("slug", team).maybeSingle();
  const teamName = (t && t.name) || team;
  const name = (p.profile && p.profile.displayName) || p.name || p.email.split("@")[0];
  const link = (Deno.env.get("APP_URL") || "https://tools.dubuddy.in/") + "?team=" + encodeURIComponent(team);

  const pw = await setTempPassword(admin, userId);
  const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const text = "Hi " + name + ",\n\n"
    + "Here are your sign-in details for the " + teamName + " team app.\n\n"
    + "Sign in here: " + link + "\n"
    + "Email: " + p.email + "\n"
    + "Temporary password: " + pw + "\n\n"
    + "When you sign in, you'll be asked to choose your own password (at least 8 characters).\n"
    + "If you didn't expect this email, please tell your team owner.\n";
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#17233A;max-width:520px">'
    + "<p>Hi " + esc(name) + ",</p>"
    + "<p>Here are your sign-in details for the <b>" + esc(teamName) + "</b> team app.</p>"
    + '<table style="border-collapse:collapse;margin:12px 0">'
    + '<tr><td style="padding:4px 14px 4px 0;color:#5C6A82">Sign in</td><td style="padding:4px 0"><a href="' + esc(link) + '">' + esc(link) + "</a></td></tr>"
    + '<tr><td style="padding:4px 14px 4px 0;color:#5C6A82">Email</td><td style="padding:4px 0">' + esc(p.email) + "</td></tr>"
    + '<tr><td style="padding:4px 14px 4px 0;color:#5C6A82">Temporary password</td><td style="padding:4px 0;font-family:monospace;font-size:16px"><b>' + esc(pw) + "</b></td></tr>"
    + "</table>"
    + "<p>When you sign in, you'll be asked to choose your own password (at least 8 characters).</p>"
    + '<p style="color:#5C6A82;font-size:13px">If you didn\'t expect this email, please tell your team owner.</p></div>';

  let sendError = null;
  try {
    const mailer = nodemailer.createTransport({
      host: Deno.env.get("SMTP_HOST") || "smtp.zoho.in",
      port: 465, secure: true,                    // Supabase allows outgoing mail on 465 only
      auth: { user: smtpUser, pass: smtpPass },
    });
    await mailer.sendMail({ from, to: p.email, subject: "Your sign-in details for the " + teamName + " team app", text, html });
  } catch (e) { sendError = (e && e.message) || String(e); }

  if (sendError) return { ok: true, emailed: false, email: p.email, emailError: sendError, tempPassword: pw };
  return { ok: true, emailed: true, email: p.email };
}
