// =====================================================================
// STAGE 15a — "idea-mail" Edge Function
//
// Emails the person behind an idea — a student who suggested it on
// tools.dubuddy.in/ideas (if they left an email), or a teammate who pitched
// it with their name — when:
//   action "approved"  their student idea was approved for the public board
//   action "status"    the idea moved (In review / Planned / In progress /
//                      Completed / Not planned)
//   action "message"   someone in the team wrote them a message (✉️ in the
//                      product space's All ideas)
//
// Who may send: the caller must be able to edit in that team — checked by
// the database function idea_mail_target (stage15a SQL), called with the
// caller's own login, which also returns the address. The browser never
// sees students' emails unless they're allowed to.
//
// Uses the same Zoho Mail secrets as manage-people:
//   SMTP_USER, SMTP_PASS, SMTP_HOST (optional), MAIL_FROM (optional)
//
// DEPLOY: whole file, name exactly  idea-mail , "Verify JWT" ON.
// =====================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
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

const STATUS: Record<string, { label: string; line: string; emoji: string }> = {
  review:   { label: "In review",   emoji: "👀", line: "Our team is looking at it." },
  planned:  { label: "Planned",     emoji: "🗓", line: "It's on our plan — we'll build it soon." },
  progress: { label: "In progress", emoji: "🚀", line: "We've started building it!" },
  done:     { label: "Completed",   emoji: "🎉", line: "It's live! Thank you for making DU Buddy better." },
  declined: { label: "Not planned", emoji: "🙏", line: "It's not on our plan right now — but please keep the ideas coming." },
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

function wrap(inner: string) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1A1614;max-width:540px">'
    + '<div style="font-weight:800;font-size:18px;margin-bottom:14px">DU <span style="color:#E8622B">Buddy</span></div>'
    + inner + '<p style="color:#8C7F75;font-size:12.5px;margin-top:26px">You got this because you shared an idea with DU Buddy.</p></div>';
}
function button(href: string, label: string) {
  return '<p style="margin:20px 0"><a href="' + esc(href) + '" style="background:#E8622B;color:#fff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:10px;display:inline-block">' + esc(label) + '</a></p>';
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Sign in first." }, 401);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const { action, kind, id } = body || {};
  if (!["approved", "status", "message"].includes(action) || !["student", "pitch"].includes(kind) || typeof id !== "string") {
    return json({ error: "Bad request" }, 400);
  }
  // the caller's own rights decide: no edit permission → no row → nothing sent
  const caller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: "Bearer " + token } } });
  const { data, error } = await caller.rpc("idea_mail_target", { p_kind: kind, p_id: id });
  if (error) return json({ sent: false, reason: error.message });
  const t = (data || [])[0];
  if (!t) return json({ sent: false, reason: "not allowed or not found" });
  if (!t.email) return json({ sent: false, reason: "no email" });

  const name = (t.name || "").split(" ")[0] || "there";
  const title = t.title || "your idea";
  const link = kind === "student" ? BOARD_URL : APP_URL + "?team=" + encodeURIComponent(t.team);
  const linkLabel = kind === "student" ? "See it on the ideas board" : "Open the team app";
  const st = STATUS[body.status] || null;
  let subject = "", text = "", html = "";

  if (action === "approved") {
    subject = "Your idea is on the DU Buddy board 🙌";
    text = "Hi " + name + ",\n\nThanks for your idea “" + title + "”! It's now live on the DU Buddy ideas board, where other students can vote for it.\n\n"
      + "See it: " + link + "\n\nWe'll email you when it moves.\n— The DU Buddy team";
    html = wrap("<p>Hi " + esc(name) + ",</p><p>Thanks for your idea <b>“" + esc(title) + "”</b>! It's now live on the DU Buddy ideas board, where other students can vote for it. 🗳</p>"
      + button(link, linkLabel) + "<p>We'll email you when it moves.<br>— The DU Buddy team</p>");
  } else if (action === "status") {
    if (!st) return json({ error: "Bad status" }, 400);
    subject = st.emoji + " Your idea is now " + st.label + " — DU Buddy";
    text = "Hi " + name + ",\n\nAn update on “" + title + "”: it's now " + st.label + ". " + st.line + "\n\n" + link + "\n\n— The DU Buddy team";
    html = wrap("<p>Hi " + esc(name) + ",</p><p>An update on <b>“" + esc(title) + "”</b>:</p>"
      + '<p style="font-size:18px;font-weight:700">' + st.emoji + " " + esc(st.label) + "</p><p>" + esc(st.line) + "</p>"
      + button(link, linkLabel) + "<p>— The DU Buddy team</p>");
  } else {
    const msg = String(body.message || "").trim().slice(0, 3000);
    if (!msg) return json({ error: "Write a message first." }, 400);
    subject = "A note about your idea “" + title.slice(0, 60) + "”";
    text = "Hi " + name + ",\n\n" + msg + "\n\nYour idea: “" + title + "”" + (st ? " — " + st.label : "") + "\n" + link + "\n\n— The DU Buddy team";
    html = wrap("<p>Hi " + esc(name) + ",</p><p style=\"white-space:pre-wrap\">" + esc(msg) + "</p>"
      + '<p style="color:#6B6058;font-size:13.5px">Your idea: <b>“' + esc(title) + "”</b>" + (st ? " · " + esc(st.emoji + " " + st.label) : "") + "</p>"
      + button(link, linkLabel) + "<p>— The DU Buddy team</p>");
  }
  const err = await sendMail(t.email, subject, text, html);
  return json(err ? { sent: false, reason: err } : { sent: true });
});
