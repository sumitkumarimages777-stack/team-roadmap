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
//   edit_person     Owner/Admin: change a teammate's name, username, sign-in
//                   email and/or password. A changed email is also updated
//                   inside the team content (OKR owners, game progress...).
//   approve_request Roles with "Approve requests": approves a teammate request
//                   (made by a Manager), creates the login, adds them to the team,
//                   emails them their sign-in details and tells the requester.
//   reject_request  Roles with "Approve requests": rejects it with a reason and
//                   emails the requester.
//   delete_person   Super-admin only: deletes a person's account for good
//                   (login, profile and every team membership). Their work in
//                   the team content (cards, OKRs...) is kept.
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
    if (body.action === "edit_person") return reply(200, await editPerson(caller, admin, me, body));
    if (body.action === "delete_person") return reply(200, await deletePerson(caller, admin, me, body));
    if (body.action === "approve_request") return reply(200, await approveRequest(caller, admin, me, body));
    if (body.action === "reject_request") return reply(200, await rejectRequest(caller, admin, me, body));
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
  if (!role) throw new Error("Pick a role.");
  if (!(await rpc(caller, "has_role", { team, min_role: "admin" }))) throw new Error("You don't have permission to manage people in this team.");
  // the team's own roles (Administration -> Roles & permissions)
  const { data: known } = await admin.from("team_roles").select("key").eq("team_slug", team).eq("key", role).maybeSingle();
  if (!known) throw new Error("Unknown role: " + role);
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
  if (!mailReady()) throw new Error("Email isn't set up yet (SMTP_USER and SMTP_PASS are missing in Supabase Edge Function secrets).");
  await checkMayReset(caller, admin, me, team, userId);

  const { data: p, error: pErr } = await admin.from("profiles").select("email,name,profile").eq("id", userId).maybeSingle();
  if (pErr || !p) throw new Error("Couldn't find that person.");
  const teamName = await teamNameOf(admin, team);
  const pw = await setTempPassword(admin, userId);
  const m = loginEmail(displayName(p), teamName, teamLink(team), p.email, pw);
  const sendError = await sendMail(p.email, m.subject, m.text, m.html);
  if (sendError) return { ok: true, emailed: false, email: p.email, emailError: sendError, tempPassword: pw };
  return { ok: true, emailed: true, email: p.email };
}

// ---------- email helpers (Zoho Mail over secure SMTP, port 465) ----------
function mailReady() { return !!(Deno.env.get("SMTP_USER") && Deno.env.get("SMTP_PASS")); }
function esc(v) { return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function displayName(p) { return (p && p.profile && p.profile.displayName) || (p && p.name) || (p && p.email ? p.email.split("@")[0] : "there"); }
function teamLink(team) { return (Deno.env.get("APP_URL") || "https://tools.dubuddy.in/") + "?team=" + encodeURIComponent(team); }
async function teamNameOf(admin, team) {
  const { data: t } = await admin.from("teams").select("name").eq("slug", team).maybeSingle();
  return (t && t.name) || team;
}
// returns null when sent, or the reason it couldn't be sent
async function sendMail(to, subject, text, html) {
  if (!mailReady()) return "email isn't set up (SMTP_USER / SMTP_PASS missing)";
  const smtpUser = Deno.env.get("SMTP_USER");
  try {
    const mailer = nodemailer.createTransport({
      host: Deno.env.get("SMTP_HOST") || "smtp.zoho.in",
      port: 465, secure: true,                    // Supabase allows outgoing mail on 465 only
      auth: { user: smtpUser, pass: Deno.env.get("SMTP_PASS") },
    });
    await mailer.sendMail({ from: Deno.env.get("MAIL_FROM") || ("Dubuddy Team <" + smtpUser + ">"), to, subject, text, html });
    return null;
  } catch (e) { return (e && e.message) || String(e); }
}
const MAIL_WRAP = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#17233A;max-width:520px">';
function loginEmail(name, teamName, link, email, pw) {
  return {
    subject: "Your sign-in details for the " + teamName + " team app",
    text: "Hi " + name + ",\n\n"
      + "Here are your sign-in details for the " + teamName + " team app.\n\n"
      + "Sign in here: " + link + "\n"
      + "Email: " + email + "\n"
      + "Temporary password: " + pw + "\n\n"
      + "When you sign in, you'll be asked to choose your own password (at least 8 characters).\n"
      + "If you didn't expect this email, please tell your team owner.\n",
    html: MAIL_WRAP
      + "<p>Hi " + esc(name) + ",</p>"
      + "<p>Here are your sign-in details for the <b>" + esc(teamName) + "</b> team app.</p>"
      + '<table style="border-collapse:collapse;margin:12px 0">'
      + '<tr><td style="padding:4px 14px 4px 0;color:#5C6A82">Sign in</td><td style="padding:4px 0"><a href="' + esc(link) + '">' + esc(link) + "</a></td></tr>"
      + '<tr><td style="padding:4px 14px 4px 0;color:#5C6A82">Email</td><td style="padding:4px 0">' + esc(email) + "</td></tr>"
      + '<tr><td style="padding:4px 14px 4px 0;color:#5C6A82">Temporary password</td><td style="padding:4px 0;font-family:monospace;font-size:16px"><b>' + esc(pw) + "</b></td></tr>"
      + "</table>"
      + "<p>When you sign in, you'll be asked to choose your own password (at least 8 characters).</p>"
      + '<p style="color:#5C6A82;font-size:13px">If you didn\'t expect this email, please tell your team owner.</p></div>',
  };
}
// a short notice: a few paragraphs and an optional link button
function noticeEmail(subject, name, paras, link) {
  return {
    subject,
    text: "Hi " + name + ",\n\n" + paras.join("\n\n") + (link ? "\n\nOpen the team app: " + link : "") + "\n",
    html: MAIL_WRAP + "<p>Hi " + esc(name) + ",</p>" + paras.map((x) => "<p>" + esc(x) + "</p>").join("")
      + (link ? '<p><a href="' + esc(link) + '">Open the team app</a></p>' : "") + "</div>",
  };
}

// ---------- approve_request / reject_request -------------------------------
// A Manager (a role with "Request teammates") asks for someone to be added; a
// role with "Approve requests" decides. Approving creates the login (if they
// don't have one), adds them to the team, and sends two emails: the person's
// sign-in details, and "approved" to the requester.
async function loadPendingRequest(caller, admin, b) {
  const id = String(b.request_id || "");
  const { data: rq, error } = await admin.from("member_requests").select("*").eq("id", id).maybeSingle();
  if (error || !rq) throw new Error("That request doesn't exist.");
  if (!(await rpc(caller, "has_perm", { team: rq.team_slug, perm: "approve_requests" }))) throw new Error("You don't have permission to approve requests in this team.");
  if (rq.status !== "pending") throw new Error("This request was already " + rq.status + ".");
  return rq;
}
async function requesterOf(admin, rq) {
  if (!rq.requested_by) return null;
  const { data } = await admin.from("profiles").select("email,name,profile").eq("id", rq.requested_by).maybeSingle();
  return data || null;
}

// body: { action, request_id, role? }   (role: the approver may change it)
async function approveRequest(caller, admin, me, b) {
  const rq = await loadPendingRequest(caller, admin, b);
  const team = rq.team_slug;
  const role = String(b.role || rq.role);
  if (role === "owner" && !(await rpc(caller, "is_super"))) throw new Error("Only the super-admin can make someone an Owner.");
  const { data: roleRow } = await admin.from("team_roles").select("key,name").eq("team_slug", team).eq("key", role).maybeSingle();
  if (!roleRow) throw new Error("Unknown role: " + role);

  // 1. the login (kept as it is if they already have one)
  const acct = await ensureAccount(admin, { email: rq.email, name: rq.name });
  // 2. the team membership (never lowers an existing Owner)
  const { data: cur } = await admin.from("memberships").select("role").eq("team_slug", team).eq("user_id", acct.id).maybeSingle();
  if (!cur || cur.role !== "owner") {
    const { error } = await admin.from("memberships").upsert({ team_slug: team, user_id: acct.id, role }, { onConflict: "team_slug,user_id" });
    if (error) throw new Error(error.message);
  }
  // 3. close the request
  const { error: upErr } = await admin.from("member_requests")
    .update({ status: "approved", role, decided_by: me.id, decided_at: new Date().toISOString(), user_id: acct.id })
    .eq("id", rq.id).eq("status", "pending");
  if (upErr) throw new Error(upErr.message);

  // 4. the two emails
  const teamName = await teamNameOf(admin, team);
  const link = teamLink(team);
  const personName = rq.name || rq.email.split("@")[0];
  const pm = acct.tempPassword
    ? loginEmail(personName, teamName, link, rq.email, acct.tempPassword)
    : noticeEmail("You've been added to the " + teamName + " team app", personName,
        ["You've been added to the " + teamName + " team as " + roleRow.name + ".", "Sign in with your existing email and password."], link);
  const personError = await sendMail(rq.email, pm.subject, pm.text, pm.html);

  let requesterError = null;
  const rqBy = await requesterOf(admin, rq);
  if (rqBy) {
    const rm = noticeEmail("Approved: " + personName + " can now join " + teamName, displayName(rqBy),
      ["Good news — your request to add " + personName + " (" + rq.email + ") to the " + teamName + " team was approved.",
       "They've been added as " + roleRow.name + " and have received an email with their sign-in details. Your teammate can now sign in to the workspace."], link);
    requesterError = await sendMail(rqBy.email, rm.subject, rm.text, rm.html);
  }
  return {
    ok: true, email: rq.email, created: acct.created,
    personEmailed: !personError, requesterEmailed: rqBy ? !requesterError : false,
    emailError: personError || requesterError || null,
    // only if their email failed: shown once to the approver so nobody is locked out
    tempPassword: personError ? acct.tempPassword : null,
  };
}

// body: { action, request_id, reason }
async function rejectRequest(caller, admin, me, b) {
  const rq = await loadPendingRequest(caller, admin, b);
  const reason = String(b.reason || "").trim().slice(0, 1000);
  const { error } = await admin.from("member_requests")
    .update({ status: "rejected", reason: reason || null, decided_by: me.id, decided_at: new Date().toISOString() })
    .eq("id", rq.id).eq("status", "pending");
  if (error) throw new Error(error.message);
  const teamName = await teamNameOf(admin, rq.team_slug);
  const personName = rq.name || rq.email.split("@")[0];
  let requesterError = null;
  const rqBy = await requesterOf(admin, rq);
  if (rqBy) {
    const rm = noticeEmail("Not approved: adding " + personName + " to " + teamName, displayName(rqBy),
      ["Your request to add " + personName + " (" + rq.email + ") to the " + teamName + " team was not approved.",
       reason ? ("Reason: " + reason) : "No reason was given. Please check with your team owner."], teamLink(rq.team_slug));
    requesterError = await sendMail(rqBy.email, rm.subject, rm.text, rm.html);
  }
  return { ok: true, requesterEmailed: rqBy ? !requesterError : false, emailError: requesterError };
}

// ---------- edit_person -------------------------------------------------
// body: { action, team, user_id, name?, username?, email?, password?, must_change? }
// Only the fields that are sent are changed. Same permission rules as a reset.
async function editPerson(caller, admin, me, b) {
  const team = String(b.team || "");
  const userId = String(b.user_id || "");
  await checkMayReset(caller, admin, me, team, userId);

  const { data: cur, error: curErr } = await admin.from("profiles").select("email,name,username").eq("id", userId).maybeSingle();
  if (curErr || !cur) throw new Error("Couldn't find that person.");
  const oldEmail = cur.email, oldName = cur.name, oldUsername = cur.username || null;   // remember before anything changes
  const changes = [];
  const prof = {};

  if (b.name !== undefined) {
    const name = String(b.name || "").trim();
    if (!name) throw new Error("The name can't be empty.");
    if (name !== oldName) { prof.name = name; changes.push("name"); }
  }
  if (b.username !== undefined) {
    const username = cleanUsername(b.username);
    if (username !== oldUsername) {
      if (username && !/^[a-z0-9._-]{2,40}$/.test(username)) throw new Error("A username can use letters, numbers, dot, dash and underscore (2\u201340 characters).");
      if (await usernameTakenByOther(admin, username, oldEmail)) throw new Error("That username is already taken.");
      prof.username = username; changes.push("username");
    }
  }

  let newEmail = null;
  if (b.email !== undefined) {
    const email = cleanEmail(b.email);
    if (email !== oldEmail) {
      if (!validEmail(email)) throw new Error("Enter a valid email.");
      const { data: taken } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
      if (taken) throw new Error("Someone else already uses that email.");
      newEmail = email;
    }
  }

  const password = String(b.password || "");
  if (password && password.length < 8) throw new Error("The password needs at least 8 characters.");

  // 1. the login itself (email and/or password)
  const authUpd = {};
  if (newEmail) { authUpd.email = newEmail; authUpd.email_confirm = true; }
  if (password) authUpd.password = password;
  if (Object.keys(authUpd).length) {
    const { error } = await admin.auth.admin.updateUserById(userId, authUpd);
    if (error) throw new Error(error.message);
  }
  if (newEmail) { prof.email = newEmail; changes.push("email"); }
  if (password) { prof.must_change_pw = b.must_change !== false; changes.push("password"); }

  // 2. the profile
  if (Object.keys(prof).length) {
    const { error } = await admin.from("profiles").update(prof).eq("id", userId);
    if (error) throw new Error(error.code === "23505" ? "That username or email is already taken." : error.message);
  }

  // 3. the old email inside team content (OKR owners, assignees, game progress...)
  let sectionsUpdated = 0;
  if (newEmail) {
    const { data: rows, error } = await admin.from("team_data").select("team_slug,section,data");
    if (error) throw new Error("Email changed, but the team content couldn't be updated: " + error.message);
    for (const r of (rows || [])) {
      const txt = JSON.stringify(r.data);
      if (!txt || txt.indexOf(oldEmail) < 0) continue;
      const next = JSON.parse(txt.split(oldEmail).join(newEmail));
      const { error: wErr } = await admin.from("team_data").update({ data: next }).eq("team_slug", r.team_slug).eq("section", r.section);
      if (wErr) throw new Error("Email changed, but some team content couldn't be updated: " + wErr.message);
      sectionsUpdated++;
    }
  }
  return { ok: true, changes, sectionsUpdated };
}

// ---------- delete_person (super-admin) -----------------------------------
// body: { action, user_id }
// The account is shared by every team, so only the super-admin may delete it.
// Deleting the login also removes the profile and memberships (the database
// links them with "on delete cascade").
async function deletePerson(caller, admin, me, b) {
  const userId = String(b.user_id || "");
  if (!(await rpc(caller, "is_super"))) throw new Error("Only a super-admin can delete a person permanently.");
  if (!userId) throw new Error("Bad request.");
  if (userId === me.id) throw new Error("You can't delete your own account.");
  const { data: p } = await admin.from("profiles").select("email,is_super").eq("id", userId).maybeSingle();
  if (p && p.is_super) throw new Error("A super-admin can't be deleted from here.");
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw new Error(error.message);
  return { ok: true, email: p ? p.email : null };
}
