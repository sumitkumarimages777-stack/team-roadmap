/* ================= Notifications: 🔔 bell + pop-ups =================
   People whose role has "Send notifications" (send_notifications; Owners
   always) send a message to the whole team or to chosen people from
   Administration → Notifications, or with the 🔔 button on a user's row.
     * Every message shows in the 🔔 bell at the top for the people it's for.
     * It can also POP UP, with a rule:
         once        — pop up one time
         times       — pop up N times
         until_ack   — keep popping up until they press "Got it"
       at most once per app visit, or once per day, and optionally only
       until a date.
   The database decides who sees what (supabase/stage11a_notifications.sql);
   receipts (popped up / read / got it) are written only through
   mark_notification(), so senders can see who has seen each message.
   Loaded before index.html's main script; uses its globals at call time
   (SUPA, TEAM, currentUser, hasPerm, adminMembers, userDisplayName,
   userAvatarColor, findUser, toast, openAdmin, renderAdminPage).            */
var NTF = { list: [], receipts: {}, loaded: false, timer: null, popped: {}, queue: [], showing: false, open: false };
var NTF_UI = { to: [], audience: "team" };   /* composer state, kept between redraws */

function ntfEl(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function ntfCanSend() { try { return !!SUPA && hasPerm("send_notifications"); } catch (_) { return false; } }
function ntfWhen(ts) {
  var d = new Date(ts), s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  if (s < 7 * 86400) return Math.floor(s / 86400) + " d ago";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
function ntfSender(n) {
  var u = (typeof USERS !== "undefined" ? USERS : []).find(function (x) { return x.id === n.created_by; });
  return u ? userDisplayName(u) : "Someone";
}
function ntfForMe(n) {
  var me = currentUser(); if (!me || n.created_by === me.id) return false;   /* never your own */
  return n.audience === "team" || (n.recipients || []).indexOf(me.id) >= 0;
}
function ntfMine() { return NTF.list.filter(ntfForMe); }
function ntfUnread() { return ntfMine().filter(function (n) { var r = NTF.receipts[n.id]; return !(r && r.read_at); }).length; }

/* ---------- styles ---------- */
(function () {
  var css = ""
  + ".corner-bell{position:relative;padding:8px 12px!important;font-size:15px!important;line-height:1}"
  + ".corner-bell .nb-dot{position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#B03A34;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid var(--card)}"
  + ".ntf-panel{position:fixed;z-index:9000;width:min(380px,calc(100vw - 24px));max-height:min(520px,calc(100vh - 90px));display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line-strong);border-radius:14px;box-shadow:0 14px 40px rgba(26,22,20,.18);overflow:hidden}"
  + ".ntf-ph{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line);font-weight:700}"
  + ".ntf-ph button{font-size:12.5px;font-weight:600;color:var(--indigo)}"
  + ".ntf-list{overflow:auto}"
  + ".ntf-item{display:block;width:100%;text-align:left;padding:12px 16px;border-bottom:1px solid var(--line);position:relative}"
  + ".ntf-item:hover{background:var(--paper)}"
  + ".ntf-item.unread{background:var(--indigo-soft)}"
  + ".ntf-item.unread::before{content:'';position:absolute;left:6px;top:18px;width:6px;height:6px;border-radius:50%;background:var(--indigo)}"
  + ".ntf-t{font-weight:600;font-size:14px}"
  + ".ntf-b{font-size:13.5px;color:var(--ink);white-space:pre-wrap;word-wrap:break-word;margin-top:3px}"
  + ".ntf-item:not(.expanded) .ntf-b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}"
  + ".ntf-m{font-size:12px;color:var(--muted);margin-top:4px}"
  + ".ntf-empty{padding:28px 16px;text-align:center;color:var(--muted);font-size:14px}"
  + ".ntf-pf{padding:10px 16px;border-top:1px solid var(--line);text-align:center}"
  + ".ntf-pf button{font-size:13px;font-weight:600;color:var(--indigo)}"
  + ".ntf-pop-bg{position:fixed;inset:0;z-index:9500;background:rgba(26,22,20,.45);display:flex;align-items:center;justify-content:center;padding:16px}"
  + ".ntf-pop{background:var(--card);border-radius:16px;max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.25);padding:24px;max-height:calc(100vh - 32px);overflow:auto}"
  + ".ntf-pop .np-k{font-family:var(--mono);font-size:11.5px;letter-spacing:.08em;color:var(--indigo);text-transform:uppercase}"
  + ".ntf-pop h3{font-size:20px;margin:6px 0 10px}"
  + ".ntf-pop .np-b{white-space:pre-wrap;word-wrap:break-word;font-size:15px;line-height:1.55}"
  + ".ntf-pop .np-m{font-size:12.5px;color:var(--muted);margin-top:14px}"
  + ".ntf-pop .np-a{display:flex;gap:10px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap}"
  + ".ntf-btn{border:1px solid var(--line-strong);border-radius:10px;padding:9px 16px;font-weight:600;font-size:14px;background:var(--card)}"
  + ".ntf-btn.primary{background:var(--indigo);border-color:var(--indigo);color:#fff}"
  + ".ntf-btn:disabled{opacity:.55;cursor:default}"
  + ".ntf-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:22px}"
  + ".ntf-card h3{font-size:16px;margin-bottom:12px}"
  + ".ntf-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}"
  + ".ntf-lab{font-size:12.5px;font-weight:600;color:var(--muted);margin:4px 0 6px;display:block}"
  + ".ntf-card textarea,.ntf-card input[type=text],.ntf-card input[type=number],.ntf-card input[type=datetime-local],.ntf-card select{border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:14px;background:var(--paper);color:var(--ink)}"
  + ".ntf-card textarea{width:100%;min-height:96px;resize:vertical}"
  + ".ntf-card input[type=text]{width:100%}"
  + ".ntf-seg{display:inline-flex;border:1px solid var(--line-strong);border-radius:10px;overflow:hidden}"
  + ".ntf-seg button{padding:8px 14px;font-size:13.5px;font-weight:600;border-right:1px solid var(--line-strong)}"
  + ".ntf-seg button:last-child{border-right:none}"
  + ".ntf-seg button.on{background:var(--indigo);color:#fff}"
  + ".ntf-people{display:flex;flex-wrap:wrap;gap:6px;max-height:180px;overflow:auto;padding:2px}"
  + ".ntf-chip{border:1px solid var(--line-strong);border-radius:99px;padding:6px 12px;font-size:13px;background:var(--card)}"
  + ".ntf-chip.on{background:var(--indigo-soft);border-color:var(--indigo);color:var(--indigo);font-weight:600}"
  + ".ntf-opt{display:flex;gap:8px;align-items:center;font-size:14px;cursor:pointer;margin:6px 0}"
  + ".ntf-sub{margin:4px 0 4px 26px;padding:12px 14px;border-left:3px solid var(--indigo-soft);display:flex;flex-direction:column;gap:6px}"
  + ".ntf-err{color:#B03A34;font-size:13px;min-height:18px}"
  + ".ntf-sent{border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:10px;background:var(--card)}"
  + ".ntf-sent .ns-top{display:flex;gap:10px;justify-content:space-between;align-items:flex-start}"
  + ".ntf-sent .ns-acts{display:flex;gap:6px;flex:none}"
  + ".ntf-sent .ns-acts button{font-size:12.5px;font-weight:600;border:1px solid var(--line-strong);border-radius:8px;padding:5px 10px}"
  + ".ntf-tag{display:inline-block;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:99px;background:var(--paper);border:1px solid var(--line);margin-right:6px;margin-top:6px}"
  + ".ntf-tag.live{background:#E3F2EA;border-color:#BFE0CC;color:#1F7A4D}"
  + ".ntf-tag.off{background:#EEF1F5;color:#5C6A82}"
  + ".ntf-who{margin-top:10px;font-size:13px;display:none}"
  + ".ntf-who.show{display:block}"
  + ".ntf-who table{border-collapse:collapse;width:100%}"
  + ".ntf-who td{padding:5px 6px;border-top:1px solid var(--line)}"
  + "@media (max-width:640px){.ntf-sent .ns-top{flex-direction:column}}";
  var st = document.createElement("style"); st.textContent = css;
  (document.head || document.documentElement).appendChild(st);
})();

/* ---------- data ---------- */
async function ntfLoad() {
  if (!SUPA || !currentUser() || typeof TEAM === "undefined" || !TEAM) return;
  var since = new Date(Date.now() - 90 * 86400000).toISOString();
  var res = await Promise.all([
    SUPA.from("team_notifications").select("*").eq("team_slug", TEAM).gte("created_at", since).order("created_at", { ascending: false }).limit(200),
    SUPA.from("notification_receipts").select("*").eq("user_id", currentUser().id)
  ]);
  if (res[0].error) throw new Error(res[0].error.message);
  NTF.list = res[0].data || [];
  NTF.receipts = {};
  (res[1].data || []).forEach(function (r) { NTF.receipts[r.notification_id] = r; });
  NTF.loaded = true;
}
async function ntfMark(n, what) {
  var r = NTF.receipts[n.id] || (NTF.receipts[n.id] = { notification_id: n.id, shown_count: 0 });
  var now = new Date().toISOString();
  if (what === "shown") { r.shown_count = (r.shown_count || 0) + 1; r.last_shown_at = now; }
  if (what === "read" || what === "ack") r.read_at = r.read_at || now;
  if (what === "ack") r.acked_at = r.acked_at || now;
  try { await SUPA.rpc("mark_notification", { n_id: n.id, what: what }); } catch (_) { }
}

/* ---------- pop-ups ---------- */
function ntfShouldPop(n) {
  if (!n.popup || n.stopped || !ntfForMe(n)) return false;
  if (n.show_until && new Date(n.show_until).getTime() < Date.now()) return false;
  if (NTF.popped[n.id]) return false;                       /* once per visit at most */
  var r = NTF.receipts[n.id] || {};
  if (r.acked_at) return false;
  var shown = r.shown_count || 0;
  if (n.popup_rule === "once" && shown >= 1) return false;
  if (n.popup_rule === "times" && shown >= (n.popup_times || 1)) return false;
  if (n.popup_gap === "day" && r.last_shown_at && new Date(r.last_shown_at).toDateString() === new Date().toDateString()) return false;
  return true;
}
function ntfCheckPopups() {
  ntfMine().slice().reverse().forEach(function (n) {           /* oldest first */
    if (ntfShouldPop(n) && NTF.queue.indexOf(n) < 0) NTF.queue.push(n);
  });
  ntfNextPopup();
}
function ntfNextPopup() {
  if (NTF.showing) return;
  var n = NTF.queue.shift(); if (!n) return;
  if (!ntfShouldPop(n)) { ntfNextPopup(); return; }
  NTF.showing = true; NTF.popped[n.id] = 1;
  ntfMark(n, "shown").then(ntfRenderBell);
  var bg = ntfEl("div", "ntf-pop-bg"), box = ntfEl("div", "ntf-pop");
  box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
  box.appendChild(ntfEl("div", "np-k", n.audience === "team" ? "📣 Message for the team" : "📩 Message for you"));
  box.appendChild(ntfEl("h3", "", n.title));
  if (n.body) box.appendChild(ntfEl("div", "np-b", n.body));
  box.appendChild(ntfEl("div", "np-m", "From " + ntfSender(n) + " · " + ntfWhen(n.created_at)));
  var acts = ntfEl("div", "np-a");
  function close() { bg.remove(); NTF.showing = false; setTimeout(ntfNextPopup, 250); }
  if (n.popup_rule === "until_ack") {
    var later = ntfEl("button", "ntf-btn", "Remind me later");
    later.onclick = function () { ntfMark(n, "read"); close(); };
    acts.appendChild(later);
  }
  var ok = ntfEl("button", "ntf-btn primary", n.popup_rule === "until_ack" ? "Got it ✓" : "OK");
  ok.onclick = function () { ntfMark(n, n.popup_rule === "until_ack" ? "ack" : "read").then(ntfRenderBell); close(); };
  acts.appendChild(ok);
  box.appendChild(acts);
  bg.appendChild(box);
  if (n.popup_rule !== "until_ack") bg.onclick = function (e) { if (e.target === bg) ok.onclick(); };
  document.body.appendChild(bg);
  setTimeout(function () { ok.focus(); }, 30);
}

/* ---------- the bell ---------- */
function ntfBellBtn() {
  var b = document.getElementById("nav-bell");
  if (b) return b;
  var acc = document.getElementById("nav-account"); if (!acc) return null;
  b = ntfEl("button", "corner-nav ghost corner-bell");
  b.id = "nav-bell"; b.type = "button"; b.title = "Notifications";
  b.onclick = function (e) { e.stopPropagation(); NTF.open ? ntfClosePanel() : ntfOpenPanel(); };
  acc.parentNode.insertBefore(b, acc);
  return b;
}
function ntfRenderBell() {
  var b = ntfBellBtn(); if (!b) return;
  if (!currentUser() || !NTF.loaded) { b.style.display = "none"; return; }
  b.style.display = "";
  var n = ntfUnread();
  b.innerHTML = "";
  b.appendChild(document.createTextNode("🔔"));
  if (n) b.appendChild(ntfEl("span", "nb-dot", n > 99 ? "99+" : String(n)));
  b.setAttribute("aria-label", n ? "Notifications, " + n + " unread" : "Notifications");
  if (NTF.open) ntfDrawPanel();
}
function ntfPanelEl() { return document.getElementById("ntf-panel"); }
function ntfOpenPanel() {
  NTF.open = true;
  var p = ntfPanelEl();
  if (!p) { p = ntfEl("div", "ntf-panel"); p.id = "ntf-panel"; p.onclick = function (e) { e.stopPropagation(); }; document.body.appendChild(p); }
  var r = document.getElementById("nav-bell").getBoundingClientRect();
  p.style.top = (r.bottom + 8) + "px";
  var w = Math.min(380, window.innerWidth - 24);              /* keep it on screen on phones */
  p.style.right = Math.min(Math.max(12, window.innerWidth - r.right), window.innerWidth - w - 12) + "px";
  ntfDrawPanel();
}
function ntfClosePanel() { NTF.open = false; var p = ntfPanelEl(); if (p) p.remove(); }
document.addEventListener("click", function () { if (NTF.open) ntfClosePanel(); });
document.addEventListener("keydown", function (e) { if (e.key === "Escape" && NTF.open) ntfClosePanel(); });
window.addEventListener("resize", function () { if (NTF.open) ntfClosePanel(); });

function ntfDrawPanel() {
  var p = ntfPanelEl(); if (!p) return;
  p.innerHTML = "";
  var mine = ntfMine();
  var head = ntfEl("div", "ntf-ph");
  head.appendChild(ntfEl("span", "", "Notifications"));
  if (ntfUnread()) {
    var all = ntfEl("button", "", "Mark all as read");
    all.onclick = function () {
      mine.forEach(function (n) { var r = NTF.receipts[n.id]; if (!(r && r.read_at)) ntfMark(n, "read"); });
      ntfRenderBell();
    };
    head.appendChild(all);
  }
  p.appendChild(head);
  var list = ntfEl("div", "ntf-list");
  if (!mine.length) list.appendChild(ntfEl("div", "ntf-empty", "No notifications yet."));
  mine.forEach(function (n) {
    var r = NTF.receipts[n.id], unread = !(r && r.read_at);
    var it = ntfEl("button", "ntf-item" + (unread ? " unread" : ""));
    it.type = "button";
    it.appendChild(ntfEl("div", "ntf-t", n.title));
    if (n.body) it.appendChild(ntfEl("div", "ntf-b", n.body));
    it.appendChild(ntfEl("div", "ntf-m", ntfSender(n) + " · " + ntfWhen(n.created_at) + (n.audience === "team" ? " · whole team" : " · just you")));
    it.onclick = function () {
      it.classList.toggle("expanded");
      if (!unread) return;
      unread = false; it.classList.remove("unread");
      ntfMark(n, "read");                                     /* marks it locally at once */
      var d = document.querySelector("#nav-bell .nb-dot"), c = ntfUnread();
      if (d) { if (c) d.textContent = c > 99 ? "99+" : String(c); else d.remove(); }
    };
    list.appendChild(it);
  });
  p.appendChild(list);
  if (ntfCanSend()) {
    var f = ntfEl("div", "ntf-pf"), s = ntfEl("button", "", "📣 Send a notification");
    s.onclick = function () { ntfClosePanel(); ntfOpenComposer(null); };
    f.appendChild(s); p.appendChild(f);
  }
}

/* ---------- start-up and refresh ---------- */
async function ntfRefresh() {
  try { await ntfLoad(); } catch (_) { return; }
  ntfRenderBell();
  ntfCheckPopups();
}
function notifBoot() {
  if (!SUPA || !currentUser()) return;
  ntfRefresh();
  if (NTF.timer) clearInterval(NTF.timer);
  NTF.timer = setInterval(function () { if (!document.hidden) ntfRefresh(); }, 3 * 60000);
  if (!NTF.visHooked) {
    NTF.visHooked = true;
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && Date.now() - (NTF.lastVis || 0) > 60000) { NTF.lastVis = Date.now(); ntfRefresh(); }
    });
  }
}

/* ---------- sending: Administration → Notifications ---------- */
function ntfOpenComposer(user) {
  NTF_UI.audience = user ? "people" : "team";
  NTF_UI.to = user ? [user.id] : [];
  NTF_UI.focus = true;
  openAdmin("notifications");
}
function ntfRuleText(n) {
  if (!n.popup) return "🔔 Bell only";
  var t = n.popup_rule === "once" ? "Pop-up once" : n.popup_rule === "times" ? "Pop-up " + n.popup_times + " times" : "Pop-up until “Got it”";
  t += n.popup_gap === "day" ? " · once a day" : " · once per visit";
  if (n.show_until) t += " · until " + new Date(n.show_until).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  return t;
}
function renderAdminNotifications(wrap) {
  var head = ntfEl("div", "admin-userhead"), left = ntfEl("div");
  var h2 = ntfEl("h2", "", "Notifications"); h2.style.margin = "0";
  var sub = ntfEl("div", "hint", "Send a message to the whole team or to chosen people. It shows in their 🔔 bell, and can also pop up on their screen.");
  sub.style.marginTop = "4px";
  left.append(h2, sub); head.appendChild(left); wrap.appendChild(head);

  var members = adminMembers().filter(function (u) { return u.id !== currentUser().id; })
    .sort(function (a, b) { return userDisplayName(a).localeCompare(userDisplayName(b)); });

  /* --- composer --- */
  var card = ntfEl("div", "ntf-card");
  card.appendChild(ntfEl("h3", "", "📣 New notification"));

  card.appendChild(ntfEl("label", "ntf-lab", "Send to"));
  var seg = ntfEl("div", "ntf-seg"), bTeam = ntfEl("button", "", "Whole team"), bPeople = ntfEl("button", "", "Choose people");
  bTeam.type = bPeople.type = "button";
  seg.append(bTeam, bPeople);
  var segRow = ntfEl("div", "ntf-row"); segRow.appendChild(seg); card.appendChild(segRow);
  var people = ntfEl("div", "ntf-people");
  card.appendChild(people);
  function drawPeople() {
    bTeam.className = NTF_UI.audience === "team" ? "on" : "";
    bPeople.className = NTF_UI.audience === "people" ? "on" : "";
    people.style.display = NTF_UI.audience === "people" ? "" : "none";
    people.innerHTML = "";
    members.forEach(function (u) {
      var on = NTF_UI.to.indexOf(u.id) >= 0;
      var c = ntfEl("button", "ntf-chip" + (on ? " on" : ""), (on ? "✓ " : "") + userDisplayName(u));
      c.type = "button"; c.title = u.email;
      c.onclick = function () { if (on) NTF_UI.to = NTF_UI.to.filter(function (x) { return x !== u.id; }); else NTF_UI.to.push(u.id); drawPeople(); };
      people.appendChild(c);
    });
    if (!members.length) people.appendChild(ntfEl("span", "hint", "Nobody else is in this team yet."));
  }
  bTeam.onclick = function () { NTF_UI.audience = "team"; drawPeople(); };
  bPeople.onclick = function () { NTF_UI.audience = "people"; drawPeople(); };
  drawPeople();

  card.appendChild(ntfEl("label", "ntf-lab", "Title"));
  var title = document.createElement("input"); title.type = "text"; title.maxLength = 140; title.placeholder = "e.g. Team meeting moved to 4 PM";
  card.appendChild(title);
  card.appendChild(ntfEl("label", "ntf-lab", "Message (optional)"));
  var body = document.createElement("textarea"); body.maxLength = 4000; body.placeholder = "Write the details here…";
  card.appendChild(body);

  card.appendChild(ntfEl("label", "ntf-lab", "How should they see it?"));
  function radio(name, val, label, checked) {
    var l = ntfEl("label", "ntf-opt"), r = document.createElement("input");
    r.type = "radio"; r.name = name; r.value = val; r.checked = !!checked;
    l.append(r, document.createTextNode(label));
    return { l: l, r: r };
  }
  var mBell = radio("ntf-mode", "bell", "🔔 Bell only — it waits in their bell at the top", true);
  var mPop = radio("ntf-mode", "popup", "💬 Bell + pop-up on their screen");
  card.append(mBell.l, mPop.l);
  var popBox = ntfEl("div", "ntf-sub");
  var rOnce = radio("ntf-rule", "once", "Show the pop-up once", true);
  var rTimes = radio("ntf-rule", "times", "Show it ");
  var times = document.createElement("input"); times.type = "number"; times.min = 1; times.max = 20; times.value = 3; times.style.width = "70px";
  rTimes.l.append(times, document.createTextNode(" times"));
  var rAck = radio("ntf-rule", "until_ack", "Keep showing it until they press “Got it”");
  var gapRow = ntfEl("div", "ntf-row"); gapRow.style.margin = "6px 0 0";
  var gap = document.createElement("select");
  [["visit", "At most once each time they open the app"], ["day", "At most once a day"]].forEach(function (o) { var op = document.createElement("option"); op.value = o[0]; op.textContent = o[1]; gap.appendChild(op); });
  gapRow.appendChild(gap);
  var untilRow = ntfEl("label", "ntf-opt"), untilChk = document.createElement("input"), until = document.createElement("input");
  untilChk.type = "checkbox"; until.type = "datetime-local"; until.disabled = true;
  untilRow.append(untilChk, document.createTextNode("Stop popping up after "), until);
  untilChk.onchange = function () { until.disabled = !untilChk.checked; if (untilChk.checked && !until.value) { var d = new Date(Date.now() + 7 * 86400000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); until.value = d.toISOString().slice(0, 16); } };
  popBox.append(rOnce.l, rTimes.l, rAck.l, gapRow, untilRow);
  card.appendChild(popBox);
  function drawMode() { popBox.style.display = mPop.r.checked ? "" : "none"; }
  mBell.r.onchange = mPop.r.onchange = drawMode; drawMode();

  var err = ntfEl("div", "ntf-err"); card.appendChild(err);
  var send = ntfEl("button", "ntf-btn primary", "Send notification"); send.type = "button";
  var sendRow = ntfEl("div", "ntf-row"); sendRow.style.justifyContent = "flex-end"; sendRow.style.margin = "0"; sendRow.appendChild(send);
  card.appendChild(sendRow);
  send.onclick = async function () {
    err.textContent = "";
    var t = title.value.trim();
    if (!t) { err.textContent = "Add a title."; title.focus(); return; }
    if (NTF_UI.audience === "people" && !NTF_UI.to.length) { err.textContent = "Choose at least one person."; return; }
    var rule = rTimes.r.checked ? "times" : rAck.r.checked ? "until_ack" : "once";
    var n = Math.max(1, Math.min(20, parseInt(times.value, 10) || 1));
    var row = {
      team_slug: TEAM, title: t, body: body.value.trim(),
      audience: NTF_UI.audience, recipients: NTF_UI.audience === "people" ? NTF_UI.to.slice() : [],
      popup: mPop.r.checked, popup_rule: rule, popup_times: rule === "times" ? n : 1, popup_gap: gap.value,
      show_until: (mPop.r.checked && untilChk.checked && until.value) ? new Date(until.value).toISOString() : null,
      created_by: currentUser().id
    };
    if (row.show_until && new Date(row.show_until).getTime() <= Date.now()) { err.textContent = "The “stop after” time is already past."; return; }
    send.disabled = true; send.textContent = "Sending…";
    var res = await SUPA.from("team_notifications").insert(row);
    send.disabled = false; send.textContent = "Send notification";
    if (res.error) { err.textContent = "Couldn't send: " + res.error.message; return; }
    var who = row.audience === "team" ? "the whole team" : row.recipients.length === 1 ? userDisplayName(members.find(function (u) { return u.id === row.recipients[0]; }) || { email: "1 person" }) : row.recipients.length + " people";
    toast("📣 Sent to " + who);
    NTF_UI.to = []; NTF_UI.audience = "team";
    await ntfRefresh();
    renderAdminPage();
  };
  wrap.appendChild(card);
  if (NTF_UI.focus) { NTF_UI.focus = false; setTimeout(function () { title.focus(); }, 60); }

  /* --- sent list --- */
  var listCard = ntfEl("div", "ntf-card");
  listCard.appendChild(ntfEl("h3", "", "Sent (last 90 days)"));
  var holder = ntfEl("div", "", "Loading…"); holder.className = "hint";
  listCard.appendChild(holder);
  wrap.appendChild(listCard);
  ntfDrawSent(holder);
}
async function ntfDrawSent(holder) {
  try { await ntfLoad(); } catch (e) { holder.textContent = "Couldn't load: " + e.message; return; }
  var ids = NTF.list.map(function (n) { return n.id; });
  var rec = {};
  if (ids.length) {
    var res = await SUPA.from("notification_receipts").select("*").in("notification_id", ids);
    (res.data || []).forEach(function (r) { (rec[r.notification_id] = rec[r.notification_id] || {})[r.user_id] = r; });
  }
  holder.className = ""; holder.innerHTML = "";
  if (!NTF.list.length) { holder.className = "hint"; holder.textContent = "Nothing sent yet."; return; }
  var team = adminMembers();
  NTF.list.forEach(function (n) {
    var targets = n.audience === "team" ? team.filter(function (u) { return u.id !== n.created_by; })
      : n.recipients.map(function (id) { return team.find(function (u) { return u.id === id; }) || { id: id, email: "(left the team)", name: "(left the team)" }; });
    var rs = rec[n.id] || {};
    var read = targets.filter(function (u) { return rs[u.id] && rs[u.id].read_at; }).length;
    var acked = targets.filter(function (u) { return rs[u.id] && rs[u.id].acked_at; }).length;
    var live = n.popup && !n.stopped && !(n.show_until && new Date(n.show_until).getTime() < Date.now());

    var box = ntfEl("div", "ntf-sent"), top = ntfEl("div", "ns-top"), info = ntfEl("div");
    info.appendChild(ntfEl("div", "ntf-t", n.title));
    if (n.body) info.appendChild(ntfEl("div", "ntf-b", n.body));
    info.appendChild(ntfEl("div", "ntf-m", "By " + ntfSender(n) + " · " + ntfWhen(n.created_at) + " · to " +
      (n.audience === "team" ? "the whole team" : targets.map(function (u) { return userDisplayName(u); }).join(", "))));
    var tags = ntfEl("div");
    tags.appendChild(ntfEl("span", "ntf-tag" + (n.popup ? (live ? " live" : " off") : ""), ntfRuleText(n) + (n.popup && !live ? (n.stopped ? " · stopped" : " · ended") : "")));
    tags.appendChild(ntfEl("span", "ntf-tag", "👀 Read " + read + "/" + targets.length));
    if (n.popup && n.popup_rule === "until_ack") tags.appendChild(ntfEl("span", "ntf-tag", "✓ Got it " + acked + "/" + targets.length));
    info.appendChild(tags);
    var acts = ntfEl("div", "ns-acts");
    var whoBtn = ntfEl("button", "", "Who saw it"); whoBtn.type = "button";
    acts.appendChild(whoBtn);
    if (live) {
      var stop = ntfEl("button", "", "Stop pop-up"); stop.type = "button"; stop.title = "Stop it popping up (it stays in the bell)";
      stop.onclick = async function () {
        stop.disabled = true;
        var r = await SUPA.from("team_notifications").update({ stopped: true }).eq("id", n.id);
        if (r.error) { toast("Couldn't stop: " + r.error.message); stop.disabled = false; return; }
        toast("Pop-up stopped"); ntfDrawSent(holder);
      };
      acts.appendChild(stop);
    }
    var del = ntfEl("button", "", "Delete"); del.type = "button"; del.title = "Delete it for everyone";
    del.onclick = async function () {
      if (!confirm("Delete “" + n.title + "”? It disappears from everyone's bell.")) return;
      var r = await SUPA.from("team_notifications").delete().eq("id", n.id);
      if (r.error) { toast("Couldn't delete: " + r.error.message); return; }
      toast("Deleted"); await ntfRefresh(); ntfDrawSent(holder);
    };
    acts.appendChild(del);
    top.append(info, acts); box.appendChild(top);

    var who = ntfEl("div", "ntf-who"), tb = document.createElement("table");
    targets.forEach(function (u) {
      var r = rs[u.id] || {}, tr = document.createElement("tr");
      var st = r.acked_at ? "✓ Got it " + ntfWhen(r.acked_at) : r.read_at ? "👀 Read " + ntfWhen(r.read_at) : r.shown_count ? "Popped up, not read yet" : "Not seen yet";
      [userDisplayName(u), st, n.popup ? "Popped up " + (r.shown_count || 0) + "×" : ""].forEach(function (x) { tr.appendChild(ntfEl("td", "", x)); });
      tb.appendChild(tr);
    });
    who.appendChild(tb);
    whoBtn.onclick = function () { who.classList.toggle("show"); };
    box.appendChild(who);
    holder.appendChild(box);
  });
}
