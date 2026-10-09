// =====================================================================
// STAGE 15 — "idea-mail" Edge Function
//
// Emails the person behind an idea — a student who suggested it on
// tools.dubuddy.in/ideas (if they left an email), or a teammate who pitched
// it with their name:
//   action "thanks"    right after they send an idea (stage15b). A student
//                      (signed out) can only trigger it for their own fresh
//                      idea; a teammate for their own named pitch; once per
//                      idea, within 30 minutes.
//   action "approved"  a student idea was approved for the public board
//   action "status"    the idea moved: review | planned | progress | done | declined
//   action "message"   someone in the team wrote them a message (✉️ in the
//                      product space's All ideas)
// For a teammate's pitch, "status" and "message" also drop a 🔔 bell
// notification in their app (team_notifications, written with the service key).
//
// The words of every email come from Administration → ✉️ Idea emails
// (table idea_email_templates, stage15c): subject + text per moment and per
// audience (student / team), or switched off. No saved template = DEFAULTS
// below. Placeholders: {name} {idea} {status} {link} {message}.
//   action "defaults"  returns DEFAULTS (the admin page shows them)
//   action "test"      sends a template to the caller's own email (needs
//                      "Review student ideas")
//   action "assign"    Marketing → a campaign item was given an accountable
//                      teammate: they get an email + a 🔔. The caller must be
//                      able to edit in the team; the person must be in it.
//
// Who may send: checked by database functions with the caller's own login —
// idea_thanks_target / idea_mail_target (stage15a/b SQL) return the address
// only when allowed. The browser never sees students' emails unless allowed.
//
// Uses the same Zoho Mail secrets as manage-people:
//   SMTP_USER, SMTP_PASS, SMTP_HOST (optional), MAIL_FROM (optional)
//
// DEPLOY: whole file, name exactly  idea-mail , "Verify JWT" OFF — the public
// ideas page calls "thanks" while signed out. Every action is still checked
// as described above.
// =====================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOARD_URL = "https://tools.dubuddy.in/ideas";
const APP_URL = (Deno.env.get("APP_URL") || "https://tools.dubuddy.in/");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function esc(v: unknown) { return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

const STATUS: Record<string, { label: string; emoji: string }> = {
  review: { label: "In review", emoji: "👀" }, planned: { label: "Planned", emoji: "🗓" },
  progress: { label: "In progress", emoji: "🚀" }, done: { label: "Completed", emoji: "🎉" },
  declined: { label: "Not planned", emoji: "🙏" },
};
const SIGN = "\n\n— The DU Buddy team";
type Tpl = { subject: string; body: string; enabled?: boolean };
const DEFAULTS: Record<string, Record<string, Tpl>> = {
  student: {
    thanks:   { subject: "Thanks for your idea! 💡 — DU Buddy", body: "Hi {name},\n\nWe got your idea “{idea}” — thank you! 💛\n\nOur team reads every idea. Once it's approved it shows on the ideas board, where other students can vote for it. We'll email you whenever it moves." + SIGN },
    approved: { subject: "Your idea is on the DU Buddy board 🙌", body: "Hi {name},\n\nThanks for your idea “{idea}”! It's now live on the DU Buddy ideas board, where other students can vote for it. 🗳\n\nWe'll email you when it moves." + SIGN },
    review:   { subject: "👀 Your idea is now In review — DU Buddy", body: "Hi {name},\n\nAn update on “{idea}”: it's now 👀 In review. Our team is looking at it." + SIGN },
    planned:  { subject: "🗓 Your idea is now Planned — DU Buddy", body: "Hi {name},\n\nGreat news about “{idea}”: it's now 🗓 Planned. It's on our plan — we'll build it soon." + SIGN },
    progress: { subject: "🚀 We're building your idea — DU Buddy", body: "Hi {name},\n\nWe've started building “{idea}”! 🚀 Thanks for helping make DU Buddy better." + SIGN },
    done:     { subject: "🎉 Your idea is live — DU Buddy", body: "Hi {name},\n\n“{idea}” is live! 🎉 It's now part of DU Buddy — thank you for making it better for every student." + SIGN },
    declined: { subject: "About your idea “{idea}” — DU Buddy", body: "Hi {name},\n\nThank you for “{idea}”. It's not on our plan right now, but we've saved it and may come back to it later. 🙏\n\nPlease keep the ideas coming — they really help us." + SIGN },
    message:  { subject: "A note about your idea “{idea}”", body: "Hi {name},\n\n{message}\n\nYour idea: “{idea}” · {status}" + SIGN },
  },
  team: {
    thanks:   { subject: "Thank you for your idea 💡", body: "Hi {name},\n\nThanks for pitching “{idea}” to the product team! 🚀 Ideas like yours are how DU Buddy gets better for students.\n\nFollow it any time in Administration → 💡 My product ideas. We'll let you know when it moves." + SIGN },
    review:   { subject: "👀 Your idea is In review", body: "Hi {name},\n\nAn update on “{idea}”: it's now 👀 In review. The product team is looking at it." + SIGN },
    planned:  { subject: "🗓 Your idea is Planned!", body: "Hi {name},\n\nGreat news — “{idea}” is now 🗓 Planned. It's on our plan." + SIGN },
    progress: { subject: "🚀 We're building your idea", body: "Hi {name},\n\nWe've started building “{idea}”! 🚀 Thanks for thinking about our students." + SIGN },
    done:     { subject: "🎉 Your idea shipped!", body: "Hi {name},\n\n“{idea}” is live! 🎉 Thank you — this one's yours. We'll celebrate it with the team." + SIGN },
    declined: { subject: "About your idea “{idea}”", body: "Hi {name},\n\nThanks for “{idea}”. It's not on our plan right now, but we've saved it and may come back to it. 🙏 Please keep pitching — it really helps." + SIGN },
    message:  { subject: "A note about your idea “{idea}”", body: "Hi {name},\n\n{message}\n\nYour idea: “{idea}” · {status}" + SIGN },
  },
};

async function sendMail(to: string, subject: string, text: string, html: string): Promise<string | null> {
  const user = Deno.env.get("SMTP_USER"), pass = Deno.env.get("SMTP_PASS");
  if (!user || !pass) return "email isn't set up (SMTP_USER / SMTP_PASS missing)";
  try {
    const mailer = nodemailer.createTransport({
      host: Deno.env.get("SMTP_HOST") || "smtp.zoho.in", port: 465, secure: true, auth: { user, pass },
    });
    await mailer.sendMail({ from: Deno.env.get("MAIL_FROM") || ("DU Buddy <" + user + ">"), to, subject, text, html });
    return null;
  } catch (e) { return (e as Error)?.message || String(e); }
}

function fill(s: string, v: Record<string, string>) { return s.replace(/\{(name|idea|status|link|message)\}/g, (_, k) => v[k] ?? ""); }
function render(tpl: Tpl, v: Record<string, string>, buttonLabel: string) {
  const subject = fill(tpl.subject, v).replace(/\s+/g, " ").trim().slice(0, 200);
  const text = fill(tpl.body, v);
  const paras = text.split(/\n{2,}/).map((p) => "<p>" + esc(p).replace(/\n/g, "<br>") + "</p>").join("");
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1A1614;max-width:540px">'
    + '<div style="font-weight:800;font-size:18px;margin-bottom:14px">DU <span style="color:#E8622B">Buddy</span></div>'
    + paras
    + '<p style="margin:20px 0"><a href="' + esc(v.link) + '" style="background:#E8622B;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:10px;display:inline-block">' + esc(buttonLabel) + "</a></p>"
    + '<p style="color:#8C7F75;font-size:12.5px;margin-top:26px">You got this because you shared an idea with DU Buddy.</p></div>';
  return { subject, text: text + "\n\n" + v.link, html };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const raw = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const token = raw.split(".").length === 3 ? raw : "";      // a signed-in user's login; the public page has none
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const { action, kind, id } = body || {};
  if (action === "defaults") return json({ defaults: DEFAULTS, statuses: STATUS });

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const caller = createClient(SUPABASE_URL, ANON_KEY, token ? { global: { headers: { Authorization: "Bearer " + token } } } : {});

  // ---- a test email to yourself, from the admin page ----
  if (action === "test") {
    if (!token) return json({ error: "Sign in first." }, 401);
    const team = String(body.team || "");
    const { data: ok } = await caller.rpc("has_perm", { team, perm: "review_student_ideas" });
    if (!ok) return json({ sent: false, reason: "Only people who review student ideas can do that." });
    const { data: who } = await admin.auth.getUser(token);
    const to = who?.user?.email;
    if (!to) return json({ sent: false, reason: "No email on your login." });
    const aud = body.audience === "team" ? "team" : "student";
    const tpl = { subject: String(body.subject || "").slice(0, 200), body: String(body.body || "").slice(0, 5000) };
    if (!tpl.subject.trim() || !tpl.body.trim()) return json({ sent: false, reason: "Subject and text can't be empty." });
    const v = { name: "Riya", idea: "College predictor right after a mock test", status: "🗓 Planned",
                link: aud === "student" ? BOARD_URL : APP_URL + "?team=" + encodeURIComponent(team),
                message: "This is where your message goes. Thanks for the idea — keep them coming! 🙌" };
    const r = render(tpl, v, aud === "student" ? "See it on the ideas board" : "Open the team app");
    const err = await sendMail(to, "[Test] " + r.subject, r.text, r.html);
    return json(err ? { sent: false, reason: err } : { sent: true, to });
  }

  // ---- a campaign item has a new accountable person ----
  if (action === "assign") {
    if (!token) return json({ error: "Sign in first." }, 401);
    const team = String(body.team || ""), uid = String(body.user_id || "");
    const { data: ok } = await caller.rpc("has_perm", { team, perm: "edit" });
    if (!ok) return json({ sent: false, reason: "not allowed" });
    const { data: who } = await admin.auth.getUser(token);
    const { data: prof } = await admin.from("profiles").select("email, name, profile, is_super").eq("id", uid).maybeSingle();
    const { data: mem } = await admin.from("memberships").select("user_id").eq("team_slug", team).eq("user_id", uid).maybeSingle();
    if (!prof || (!mem && !prof.is_super)) return json({ sent: false, reason: "that person isn't in this team" });
    const it = body.item || {};
    const camp = String(body.campaign || "the campaign").slice(0, 140);
    const name = String((prof.profile && prof.profile.displayName) || prof.name || "there").split(" ")[0];
    const item = String(it.name || "an item").slice(0, 140);
    const kindL = String(it.kind === "Other" && it.kindOther ? it.kindOther : (it.kind || "")).slice(0, 60);
    const when = it.date ? new Date(it.date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "no date yet";
    const link = APP_URL + "?team=" + encodeURIComponent(team);
    const lines = [["What", kindL], ["Where", String(it.platform || "")], ["When", when], ["Campaign", camp]].filter((x) => x[1]);
    const details = String(it.details || "").slice(0, 2000);
    const subject = "📣 You're on “" + item + "” — " + camp;
    const text = "Hi " + name + ",\n\nYou're accountable for “" + item + "” in " + camp + ".\n\n"
      + lines.map((x) => x[0] + ": " + x[1]).join("\n") + (details ? "\n\nDetails:\n" + details : "") + "\n\n" + link + "\n\n— The DU Buddy team";
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1A1614;max-width:540px">'
      + '<div style="font-weight:800;font-size:18px;margin-bottom:14px">DU <span style="color:#E8622B">Buddy</span></div>'
      + "<p>Hi " + esc(name) + ",</p><p>You're accountable for <b>“" + esc(item) + "”</b> in <b>" + esc(camp) + "</b>.</p>"
      + '<table style="border-collapse:collapse;margin:10px 0">' + lines.map((x) => '<tr><td style="color:#8C7F75;padding:3px 14px 3px 0">' + esc(x[0]) + "</td><td><b>" + esc(x[1]) + "</b></td></tr>").join("") + "</table>"
      + (details ? '<p style="white-space:pre-wrap;background:#FBF6F1;border-radius:8px;padding:10px 12px">' + esc(details) + "</p>" : "")
      + '<p style="margin:20px 0"><a href="' + esc(link) + '" style="background:#E8622B;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:10px;display:inline-block">Open the team app</a></p>'
      + "<p>— The DU Buddy team</p></div>";
    const err = prof.email ? await sendMail(prof.email, subject, text, html) : "no email";
    let belled = false;
    if (who?.user && who.user.id !== uid) {
      const ins = await admin.from("team_notifications").insert({
        team_slug: team, title: "📣 You're on “" + item + "”", body: camp + " · " + [kindL, it.platform, when].filter(Boolean).join(" · ") + (details ? "\n\n" + details.slice(0, 600) : ""),
        audience: "people", recipients: [uid], bell: true, popup: false, created_by: who.user.id,
      });
      belled = !ins.error;
    }
    return json(err ? { sent: false, reason: err, belled } : { sent: true, belled });
  }

  if (!["approved", "status", "message", "thanks"].includes(action) || !["student", "pitch"].includes(kind) || typeof id !== "string") {
    return json({ error: "Bad request" }, 400);
  }
  if (!token && !(action === "thanks" && kind === "student")) return json({ error: "Sign in first." }, 401);
  // the caller's own rights decide: not allowed → no row → nothing sent
  const { data, error } = await caller.rpc(action === "thanks" ? "idea_thanks_target" : "idea_mail_target", { p_kind: kind, p_id: id });
  if (error) return json({ sent: false, reason: error.message });
  const t = (data || [])[0];
  if (!t) return json({ sent: false, reason: "not allowed or not found" });

  const aud = kind === "student" ? "student" : "team";
  const key = action === "status" ? String(body.status || "") : action;
  if (action === "status" && !STATUS[key]) return json({ error: "Bad status" }, 400);
  const st = STATUS[String(body.status || "")] || null;
  const title = t.title || "your idea";
  const v = {
    name: (t.name || "").split(" ")[0] || "there",
    idea: title,
    status: st ? st.emoji + " " + st.label : "",
    link: kind === "student" ? BOARD_URL : APP_URL + "?team=" + encodeURIComponent(t.team),
    message: String(body.message || "").trim().slice(0, 3000),
  };
  if (action === "message" && !v.message) return json({ error: "Write a message first." }, 400);

  // the team's saved words for this moment (or the defaults); switched off = no email
  let tpl: Tpl | undefined = DEFAULTS[aud][key];
  const { data: saved } = await admin.from("idea_email_templates").select("enabled, subject, body")
    .eq("team_slug", t.team).eq("key", key).eq("audience", aud).maybeSingle();
  if (saved) tpl = saved as Tpl;

  let err: string | null = null, sent = false;
  if (!t.email) err = "no email";
  else if (!tpl) err = "no template";
  else if (tpl.enabled === false) err = "this email is switched off in Administration → Idea emails";
  else {
    const r = render(tpl, v, kind === "student" ? "See it on the ideas board" : "Open the team app");
    err = await sendMail(t.email, r.subject, r.text, r.html);
    sent = !err;
  }

  // a teammate's pitch moved or got a message: also a 🔔 in their app
  let belled = false;
  if (kind === "pitch" && (action === "status" || action === "message") && token) {
    try {
      const { data: who } = await admin.auth.getUser(token);
      const { data: pp } = await admin.from("product_pitches").select("by_user, team_slug").eq("id", id).maybeSingle();
      if (who?.user && pp?.by_user && pp.by_user !== who.user.id) {
        const head = action === "message" ? "💬 A note about your idea" : (st ? st.emoji + " Your idea is now " + st.label : "💡 Your idea moved");
        const ins = await admin.from("team_notifications").insert({
          team_slug: pp.team_slug, title: head, body: "“" + title + "”" + (v.message ? "\n\n" + v.message : ""),
          audience: "people", recipients: [pp.by_user], bell: true, popup: false, created_by: who.user.id,
        });
        belled = !ins.error;
      }
    } catch (_) { /* the email part already happened */ }
  }
  return json(sent ? { sent: true, belled } : { sent: false, reason: err, belled });
});
