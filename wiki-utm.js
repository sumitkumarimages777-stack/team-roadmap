/* ================= UTM builder (Wiki → Marketing) =================
   One place where the team builds campaign links, so every UTM follows the
   same rules.
     * Rules  — allowed sources, mediums (per source), campaign products and
                the campaign format. Saved in team data "utmRules"; only roles
                with "Edit UTM rules" (edit_utm) can save it (enforced by the
                database, supabase/stage10a_utm.sql).
     * Build  — anyone in the team picks from the rules; the link is cleaned
                (lowercase, hyphens, no spaces) and checked before it can be
                copied or saved.
     * Links  — every saved link, in "utmLinks" (any team member can add).
   Loaded after index.html's main script; uses its globals (dlView,
   renderDocLib, hasPerm, pushAll, toast, mtEsc, dlMe, ppMemName).         */
var UTM_RULES = null;            /* null = never saved: the defaults below apply */
var UTM_LINKS = { links: [] };
var UTM_UI = { tab: "build", f: {}, q: "", fs: "", fm: "", fb: "", draft: null };

var UTM_DEFAULTS = {
  sources: [
    { v: "instagram", label: "Instagram", mediums: ["social", "paid-social", "bio-link", "story", "influencer"] },
    { v: "youtube",   label: "YouTube",   mediums: ["social", "video", "paid-video", "influencer"] },
    { v: "facebook",  label: "Facebook",  mediums: ["social", "paid-social"] },
    { v: "whatsapp",  label: "WhatsApp",  mediums: ["chat", "broadcast", "community"] },
    { v: "telegram",  label: "Telegram",  mediums: ["chat", "broadcast", "community"] },
    { v: "google",    label: "Google",    mediums: ["cpc", "display", "organic"] },
    { v: "linkedin",  label: "LinkedIn",  mediums: ["social", "paid-social"] },
    { v: "newsletter",label: "Email newsletter", mediums: ["email"] },
    { v: "sms",       label: "SMS",       mediums: ["sms"] },
    { v: "website",   label: "Our website", mediums: ["banner", "popup", "referral"] },
    { v: "offline",   label: "Offline (posters, events)", mediums: ["qr"] }
  ],
  mediums: [
    { v: "social",      label: "Organic social post" },
    { v: "paid-social", label: "Paid social ad" },
    { v: "bio-link",    label: "Link in bio" },
    { v: "story",       label: "Story" },
    { v: "video",       label: "Video description / pinned comment" },
    { v: "paid-video",  label: "Paid video ad" },
    { v: "influencer",  label: "Influencer / creator" },
    { v: "chat",        label: "1-to-1 or group chat" },
    { v: "broadcast",   label: "Broadcast list / channel" },
    { v: "community",   label: "Community group" },
    { v: "cpc",         label: "Search ad (pay per click)" },
    { v: "display",     label: "Display / banner ad" },
    { v: "organic",     label: "Organic search" },
    { v: "email",       label: "Email" },
    { v: "sms",         label: "SMS" },
    { v: "banner",      label: "Website banner" },
    { v: "popup",       label: "Website pop-up" },
    { v: "referral",    label: "Referral / partner" },
    { v: "qr",          label: "QR code" }
  ],
  products: [
    { v: "cuet",          label: "CUET prep" },
    { v: "du-admissions", label: "DU admissions" },
    { v: "webinar",       label: "Webinar" },
    { v: "app",           label: "App installs" },
    { v: "brand",         label: "Brand / general" }
  ],
  datePrefix: true,
  guide: "Use this builder for every campaign link — never type UTMs by hand.\n" +
         "Only the values listed here are allowed. Need a new one? Ask whoever can edit UTM rules.\n" +
         "Campaign = month_product_short-name, e.g. 2026-10_cuet_mock-test-launch.\n" +
         "utm_content tells versions apart (e.g. reel-1, story-swipe, creator-sivam).\n" +
         "Save every link here so we can find and reuse it."
};

/* ---------- data ---------- */
function utmSlug(s) {
  return String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
function utmCleanList(a, withMediums) {
  var seen = {};
  return (Array.isArray(a) ? a : []).map(function (x) {
    var o = { v: utmSlug(x && x.v), label: String((x && x.label) || "").trim() };
    if (withMediums) o.mediums = (Array.isArray(x && x.mediums) ? x.mediums : []).map(utmSlug).filter(Boolean);
    return o;
  }).filter(function (x) { if (!x.v || seen[x.v]) return false; seen[x.v] = 1; if (!x.label) x.label = x.v; return true; });
}
function normalizeUtmRules(r) {
  if (!r || typeof r !== "object") return null;
  return {
    sources: utmCleanList(r.sources, true), mediums: utmCleanList(r.mediums), products: utmCleanList(r.products),
    datePrefix: r.datePrefix !== false, guide: String(r.guide || ""),
    updatedBy: r.updatedBy || "", updatedAt: r.updatedAt || ""
  };
}
function normalizeUtmLinks(d) {
  d = (d && typeof d === "object") ? d : {};
  return { links: (Array.isArray(d.links) ? d.links : []).filter(function (l) { return l && l.url; }) };
}
function utmRules() { return UTM_RULES || UTM_DEFAULTS; }
function utmCanEdit() { return typeof hasPerm === "function" && hasPerm("edit_utm"); }
function utmFind(list, v) { for (var i = 0; i < list.length; i++) if (list[i].v === v) return list[i]; return null; }
function utmMediumsFor(src) {
  var R = utmRules(), s = utmFind(R.sources, src);
  if (!s) return [];
  if (!s.mediums || !s.mediums.length) return R.mediums;
  return R.mediums.filter(function (m) { return s.mediums.indexOf(m.v) >= 0; });
}
function utmMonth() { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }

/* the campaign value and the full link for the builder's current fields */
function utmCampaign(f) {
  var R = utmRules();
  return [R.datePrefix ? (f.month || utmMonth()) : "", f.product || "", utmSlug(f.name)].filter(Boolean).join("_");
}
function utmDest(raw) {
  var u = String(raw || "").trim(); if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { var x = new URL(u); return /\./.test(x.hostname) ? x : null; } catch (e) { return null; }
}
function utmBuild(f) {
  var x = utmDest(f.url); if (!x) return "";
  ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id"].forEach(function (k) { x.searchParams.delete(k); });
  x.searchParams.set("utm_source", f.source || "");
  x.searchParams.set("utm_medium", f.medium || "");
  x.searchParams.set("utm_campaign", utmCampaign(f));
  if (utmSlug(f.content)) x.searchParams.set("utm_content", utmSlug(f.content));
  if (utmSlug(f.term)) x.searchParams.set("utm_term", utmSlug(f.term));
  return x.toString();
}
function utmChecks(f) {
  var R = utmRules(), x = utmDest(f.url), out = [];
  out.push([!!x, x ? "Destination is a valid link" : "Paste the page the link should open (e.g. dubuddy.in/cuet)"]);
  if (x && /[?&]utm_/i.test(String(f.url))) out.push([true, "The pasted link already had UTMs — they are replaced by these"]);
  out.push([!!utmFind(R.sources, f.source), "Source picked from the list"]);
  var ms = utmMediumsFor(f.source);
  out.push([!!f.medium && ms.some(function (m) { return m.v === f.medium; }), f.source ? "Medium allowed for this source" : "Medium picked from the list"]);
  out.push([!!utmFind(R.products, f.product), "Campaign product picked"]);
  out.push([utmSlug(f.name).length >= 3, "Campaign short name (3+ letters)"]);
  return out;
}
function utmSave() { if (typeof pushAll === "function") pushAll(); }

/* ---------- render ---------- */
function utmIsMarketing(u) { return !!u && /marketing/i.test(u.name || ""); }
function utmHead(h) {
  var R = utmRules();
  h.innerHTML = '<h2>🔗 UTM builder</h2><p>Every campaign link, built the same way. Pick from the rules, copy, and it’s saved for the team.' +
    (UTM_RULES && UTM_RULES.updatedAt ? ' Rules last changed ' + mtEsc(UTM_RULES.updatedAt) + (UTM_RULES.updatedBy ? ' by ' + mtEsc(ppMemName(UTM_RULES.updatedBy)) : '') + '.' : '') + '</p>' +
    '<div class="dl-seg utm-tabs" style="display:inline-flex;margin-top:12px">' +
    [["build", "Build a link"], ["links", "Team links (" + UTM_LINKS.links.length + ")"], ["rules", "Rules" + (utmCanEdit() ? " ✎" : " 🔒")]].map(function (t) {
      return '<button data-utmtab="' + t[0] + '" class="' + (UTM_UI.tab === t[0] ? "on" : "") + '">' + mtEsc(t[1]) + '</button>';
    }).join("") + '</div>';
  h.querySelectorAll("[data-utmtab]").forEach(function (b) { b.onclick = function () { UTM_UI.tab = b.dataset.utmtab; UTM_UI.draft = null; renderDocLib(); }; });
}
function utmBody(list) {
  list.innerHTML = UTM_UI.tab === "rules" ? utmRulesHTML() : UTM_UI.tab === "links" ? utmLinksHTML() : utmBuildHTML();
  if (UTM_UI.tab === "rules") utmWireRules(list); else if (UTM_UI.tab === "links") utmWireLinks(list); else utmWireBuild(list);
}
function utmOpts(list, cur, ph) {
  return '<option value="">' + mtEsc(ph) + '</option>' + list.map(function (x) {
    return '<option value="' + mtEsc(x.v) + '"' + (x.v === cur ? " selected" : "") + '>' + mtEsc(x.label) + ' — ' + mtEsc(x.v) + '</option>';
  }).join("");
}

function utmBuildHTML() {
  var R = utmRules(), f = UTM_UI.f;
  if (!f.month) f.month = utmMonth();
  if (f.medium && !utmMediumsFor(f.source).some(function (m) { return m.v === f.medium; })) f.medium = "";
  return '<div class="utm-grid"><div class="utm-card">' +
    '<div class="field"><label>1 · Page the link opens</label><input data-utmf="url" value="' + mtEsc(f.url || "") + '" placeholder="e.g. https://dubuddy.in/cuet" autocomplete="off"></div>' +
    '<div class="dl-row2"><div class="field"><label>2 · Source <span class="hint">where the click comes from</span></label><select data-utmf="source">' + utmOpts(R.sources, f.source, "Pick a source…") + '</select></div>' +
    '<div class="field"><label>3 · Medium <span class="hint">what kind of placement</span></label><select data-utmf="medium"' + (f.source ? "" : " disabled") + '>' +
      utmOpts(utmMediumsFor(f.source), f.medium, f.source ? "Pick a medium…" : "Pick a source first") + '</select></div></div>' +
    '<div class="field"><label>4 · Campaign</label><div class="utm-camp">' +
      (R.datePrefix ? '<input data-utmf="month" type="month" value="' + mtEsc(f.month) + '" style="max-width:150px">' : '') +
      '<select data-utmf="product">' + utmOpts(R.products, f.product, "Product…") + '</select>' +
      '<input data-utmf="name" value="' + mtEsc(f.name || "") + '" placeholder="short name, e.g. mock test launch" autocomplete="off"></div></div>' +
    '<div class="dl-row2"><div class="field"><label>Content <span class="hint">optional — which version</span></label><input data-utmf="content" value="' + mtEsc(f.content || "") + '" placeholder="e.g. reel-1, creator-sivam" autocomplete="off"></div>' +
    '<div class="field"><label>Term <span class="hint">optional — paid keyword</span></label><input data-utmf="term" value="' + mtEsc(f.term || "") + '" placeholder="e.g. cuet coaching" autocomplete="off"></div></div>' +
    '<div class="field"><label>Note <span class="hint">optional — where this link is used</span></label><input data-utmf="note" value="' + mtEsc(f.note || "") + '" placeholder="e.g. Oct 12 reel caption" autocomplete="off"></div>' +
    '</div><div class="utm-card utm-out" id="utm-out">' + utmOutHTML() + '</div></div>';
}
function utmOutHTML() {
  var f = UTM_UI.f, checks = utmChecks(f), ok = checks.every(function (c) { return c[0]; }), url = ok ? utmBuild(f) : "";
  var dup = url ? UTM_LINKS.links.find(function (l) { return l.url === url; }) : null;
  return '<div class="lbl">Your link</div>' +
    '<div class="utm-url' + (ok ? "" : " off") + '">' + (ok ? mtEsc(url) : "Fill in the steps on the left — the link appears here.") + '</div>' +
    '<div class="utm-parts">' + [["utm_source", f.source], ["utm_medium", f.medium], ["utm_campaign", utmCampaign(f)], ["utm_content", utmSlug(f.content)], ["utm_term", utmSlug(f.term)]]
      .filter(function (p) { return p[1]; }).map(function (p) { return '<span><b>' + p[0] + '</b>=' + mtEsc(p[1]) + '</span>'; }).join("") + '</div>' +
    '<ul class="utm-checks">' + checks.map(function (c) { return '<li class="' + (c[0] ? "ok" : "no") + '">' + (c[0] ? "✓" : "○") + " " + mtEsc(c[1]) + '</li>'; }).join("") + '</ul>' +
    (dup ? '<div class="dl-warn">This exact link was already saved by ' + mtEsc(ppMemName(dup.by)) + ' on ' + mtEsc(dup.at) + '. Reuse it — copying won’t save a second one.</div>' : '') +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' +
      '<button class="dl-add" data-utmgo="save"' + (ok ? "" : " disabled") + '>' + (dup ? "Copy link" : "Copy & save for the team") + '</button>' +
      '<button class="dl-btn" data-utmgo="clear">Start over</button></div>';
}
function utmWireBuild(root) {
  function refreshOut() { var o = root.querySelector("#utm-out"); o.innerHTML = utmOutHTML(); wireOut(o); }
  function wireOut(o) {
    o.querySelectorAll("[data-utmgo]").forEach(function (b) {
      b.onclick = function () {
        if (b.dataset.utmgo === "clear") { UTM_UI.f = {}; renderDocLib(); return; }
        var f = UTM_UI.f, url = utmBuild(f); if (!url) return;
        utmCopy(url);
        if (!UTM_LINKS.links.some(function (l) { return l.url === url; })) {
          var x = utmDest(f.url);
          UTM_LINKS.links.unshift({ id: "utm-" + Math.random().toString(36).slice(2, 9), url: url, dest: x.origin + x.pathname,
            source: f.source, medium: f.medium, campaign: utmCampaign(f), content: utmSlug(f.content), term: utmSlug(f.term),
            note: String(f.note || "").trim(), by: dlMe(), at: dlToday() });
          utmSave(); toast("Copied and saved to Team links");
          if (typeof renderDocLib === "function") renderDocLib();
        }
      };
    });
  }
  root.querySelectorAll("[data-utmf]").forEach(function (el) {
    var k = el.dataset.utmf;
    /* text boxes update on typing only: a "change" on blur would rebuild the
       buttons under the mouse and swallow the click */
    el[el.tagName === "SELECT" || el.type === "month" ? "onchange" : "oninput"] = function () {
      UTM_UI.f[k] = el.value;
      if (k === "source") { renderDocLib(); return; }          /* medium list depends on it */
      refreshOut();
    };
  });
  wireOut(root.querySelector("#utm-out"));
}
function utmCopy(t) {
  var ask = function () { window.prompt("Copy this link:", t); };
  try { navigator.clipboard.writeText(t).catch(ask); } catch (e) { ask(); }
}

function utmLinksHTML() {
  var R = utmRules(), q = UTM_UI.q.toLowerCase();
  var rows = UTM_LINKS.links.filter(function (l) {
    if (UTM_UI.fs && l.source !== UTM_UI.fs) return false;
    if (UTM_UI.fm && l.medium !== UTM_UI.fm) return false;
    if (UTM_UI.fb && l.by !== UTM_UI.fb) return false;
    return !q || (l.url + " " + (l.note || "") + " " + ppMemName(l.by)).toLowerCase().indexOf(q) >= 0;
  });
  var uniq = function (k) { var s = {}; UTM_LINKS.links.forEach(function (l) { if (l[k]) s[l[k]] = 1; }); return Object.keys(s).sort(); };
  var sel = function (key, vals, cur, ph, name) {
    return '<select data-utmflt="' + key + '"><option value="">' + ph + '</option>' + vals.map(function (v) {
      return '<option value="' + mtEsc(v) + '"' + (v === cur ? " selected" : "") + '>' + mtEsc(name ? name(v) : v) + '</option>'; }).join("") + '</select>';
  };
  var offRule = function (l) {
    var s = utmFind(R.sources, l.source);
    return !s || !utmMediumsFor(l.source).some(function (m) { return m.v === l.medium; });
  };
  return '<div class="utm-bar"><input data-utmflt="q" class="dl-search" placeholder="Search links, notes, people…" value="' + mtEsc(UTM_UI.q) + '">' +
    sel("fs", uniq("source"), UTM_UI.fs, "All sources") + sel("fm", uniq("medium"), UTM_UI.fm, "All mediums") +
    sel("fb", uniq("by"), UTM_UI.fb, "Everyone", ppMemName) +
    '<button class="dl-btn" data-utmcsv="1">⬇ CSV</button></div>' +
    (rows.length ? rows.map(function (l) {
      var mine = l.by === dlMe();
      return '<div class="dl-row utm-row" data-utmid="' + mtEsc(l.id) + '"><div class="dl-main">' +
        '<div class="utm-camp-t">' + mtEsc(l.campaign) + (offRule(l) ? ' <span class="dl-stale" title="This source/medium is no longer in the rules">⚠️ not in current rules</span>' : '') + '</div>' +
        '<div class="utm-url sm">' + mtEsc(l.url) + '</div>' +
        '<div class="dl-meta"><span class="dl-chip">' + mtEsc(l.source) + '</span><span class="dl-chip">' + mtEsc(l.medium) + '</span>' +
          (l.content ? '<span class="dl-chip unit">' + mtEsc(l.content) + '</span>' : '') +
          '<span>' + mtEsc(mine ? "you" : ppMemName(l.by)) + ' · ' + mtEsc(l.at) + '</span>' + (l.note ? '<span>· ' + mtEsc(l.note) + '</span>' : '') + '</div></div>' +
        '<div class="dl-acts"><button class="dl-btn go" data-utmcopy="1">Copy</button><button class="dl-btn" data-utmreuse="1" title="Build a new link starting from this one">Reuse</button>' +
        ((mine || utmCanEdit()) ? '<button class="dl-btn del" data-utmdel="1" title="Remove from the list">×</button>' : '') + '</div></div>';
    }).join("") : '<div class="dl-empty">' + (UTM_LINKS.links.length ? "No links match." : "No links yet. Build one in “Build a link”.") + '</div>');
}
function utmWireLinks(root) {
  root.querySelectorAll("[data-utmflt]").forEach(function (el) {
    el[el.tagName === "SELECT" ? "onchange" : "oninput"] = function () {
      UTM_UI[el.dataset.utmflt] = el.value;
      var pos = el.selectionStart; renderDocLib();
      if (el.dataset.utmflt === "q") { var n = document.querySelector('[data-utmflt="q"]'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} } }
    };
  });
  var csv = root.querySelector("[data-utmcsv]");
  if (csv) csv.onclick = function () {
    var esc = function (v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [["date", "made by", "campaign", "source", "medium", "content", "term", "note", "link"].join(",")].concat(UTM_LINKS.links.map(function (l) {
      return [l.at, ppMemName(l.by), l.campaign, l.source, l.medium, l.content, l.term, l.note, l.url].map(esc).join(","); }));
    var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = "utm-links.csv"; a.click();
  };
  root.querySelectorAll("[data-utmid]").forEach(function (r) {
    var l = UTM_LINKS.links.find(function (x) { return x.id === r.dataset.utmid; }); if (!l) return;
    var c = r.querySelector("[data-utmcopy]"); c.onclick = function () { utmCopy(l.url); toast("Link copied"); };
    r.querySelector("[data-utmreuse]").onclick = function () {
      var parts = String(l.campaign || "").split("_"), R = utmRules();
      var f = { url: l.dest || "", source: l.source, medium: l.medium, content: l.content, term: l.term };
      if (R.datePrefix && /^\d{4}-\d{2}$/.test(parts[0])) f.month = parts.shift();
      if (parts.length && utmFind(R.products, parts[0])) f.product = parts.shift();
      f.name = parts.join("-");
      UTM_UI.f = f; UTM_UI.tab = "build"; renderDocLib(); toast("Loaded — change what you need");
    };
    var d = r.querySelector("[data-utmdel]");
    if (d) d.onclick = function () {
      if (!window.confirm("Remove this link from the team list? Links already shared keep working.")) return;
      UTM_LINKS.links = UTM_LINKS.links.filter(function (x) { return x.id !== l.id; }); utmSave(); renderDocLib(); toast("Removed");
    };
  });
}

/* ---------- rules ---------- */
function utmRulesHTML() {
  var can = utmCanEdit(), R = UTM_UI.draft || utmRules();
  var lock = can ? '<div class="dl-warn" style="margin:0 0 14px">You can change these. Everyone else sees them read-only. Changing a rule doesn’t change links already made — those get a ⚠️ in Team links.</div>'
    : '<div class="dl-warn" style="margin:0 0 14px">🔒 Only roles with <b>Edit UTM rules</b> can change these. An owner grants it in Administration → Roles &amp; permissions.</div>';
  var guide = '<div class="utm-card"><div class="lbl">How we tag links</div>' + (can
    ? '<textarea data-utmr="guide" rows="6" style="width:100%">' + mtEsc(R.guide) + '</textarea>'
    : '<ol class="utm-guide">' + String(R.guide || "").split("\n").filter(function (s) { return s.trim(); }).map(function (s) { return '<li>' + mtEsc(s) + '</li>'; }).join("") + '</ol>') +
    '<p class="hint" style="margin:8px 0 0">Always applied automatically: lowercase only, spaces become hyphens, parts of the campaign are joined with “_”.</p>' +
    '<label class="dl-check" style="margin-top:8px"><input type="checkbox" data-utmr="datePrefix"' + (R.datePrefix ? " checked" : "") + (can ? "" : " disabled") + '> Campaign starts with the month (2026-10_…)</label></div>';
  function table(key, title, hint, list) {
    var withM = key === "sources";
    return '<div class="utm-card"><div class="lbl">' + title + '</div><p class="hint" style="margin:0 0 8px">' + hint + '</p>' +
      '<table class="utm-tbl"><thead><tr><th>Value in the link</th><th>Name people see</th>' + (withM ? '<th>Allowed mediums</th>' : '') + (can ? '<th></th>' : '') + '</tr></thead><tbody>' +
      list.map(function (x, i) {
        return '<tr><td>' + (can ? '<input data-utml="' + key + '" data-i="' + i + '" data-k="v" value="' + mtEsc(x.v) + '">' : '<code>' + mtEsc(x.v) + '</code>') + '</td>' +
          '<td>' + (can ? '<input data-utml="' + key + '" data-i="' + i + '" data-k="label" value="' + mtEsc(x.label) + '">' : mtEsc(x.label)) + '</td>' +
          (withM ? '<td>' + (can
            ? '<div class="utm-ms">' + R.mediums.map(function (m) {
                return '<label><input type="checkbox" data-utmm="' + i + '" value="' + mtEsc(m.v) + '"' + ((x.mediums || []).indexOf(m.v) >= 0 ? " checked" : "") + '>' + mtEsc(m.v) + '</label>'; }).join("") + '</div>'
            : ((x.mediums && x.mediums.length) ? x.mediums.map(function (m) { return '<span class="dl-chip">' + mtEsc(m) + '</span>'; }).join(" ") : '<span class="hint">any</span>')) + '</td>' : '') +
          (can ? '<td><button class="dl-btn del" data-utmrm="' + key + '" data-i="' + i + '">×</button></td>' : '') + '</tr>';
      }).join("") + '</tbody></table>' + (can ? '<button class="dl-btn" data-utmadd="' + key + '" style="margin-top:8px">＋ Add</button>' : '') + '</div>';
  }
  return lock + guide +
    table("sources", "Sources (utm_source)", "Where the click comes from. Tick which mediums each source may use; none ticked = any.", R.sources) +
    table("mediums", "Mediums (utm_medium)", "What kind of placement it is.", R.mediums) +
    table("products", "Campaign products", "The first word of every campaign after the month.", R.products) +
    (can ? '<div style="display:flex;gap:8px;margin-top:6px"><button class="dl-add" data-utmrsave="1">Save rules</button>' +
      '<button class="dl-btn" data-utmrcancel="1">Undo changes</button><button class="dl-btn" data-utmrdef="1" style="margin-left:auto">Reset to the starter rules</button></div>' : '');
}
function utmWireRules(root) {
  if (!utmCanEdit()) return;
  if (!UTM_UI.draft) UTM_UI.draft = JSON.parse(JSON.stringify(utmRules()));
  var D = UTM_UI.draft;
  root.querySelectorAll("[data-utml]").forEach(function (el) {
    el.oninput = function () { D[el.dataset.utml][+el.dataset.i][el.dataset.k] = el.value; };
    if (el.dataset.k === "v") el.onblur = function () { el.value = utmSlug(el.value); D[el.dataset.utml][+el.dataset.i].v = el.value; };
  });
  root.querySelectorAll("[data-utmm]").forEach(function (cb) {
    cb.onchange = function () {
      var s = D.sources[+cb.dataset.utmm]; s.mediums = s.mediums || [];
      if (cb.checked) { if (s.mediums.indexOf(cb.value) < 0) s.mediums.push(cb.value); } else s.mediums = s.mediums.filter(function (m) { return m !== cb.value; });
    };
  });
  var g = root.querySelector('[data-utmr="guide"]'); if (g) g.oninput = function () { D.guide = g.value; };
  var dp = root.querySelector('[data-utmr="datePrefix"]'); if (dp) dp.onchange = function () { D.datePrefix = dp.checked; };
  root.querySelectorAll("[data-utmadd]").forEach(function (b) { b.onclick = function () { var k = b.dataset.utmadd; D[k].push(k === "sources" ? { v: "", label: "", mediums: [] } : { v: "", label: "" }); renderDocLib(); }; });
  root.querySelectorAll("[data-utmrm]").forEach(function (b) { b.onclick = function () { D[b.dataset.utmrm].splice(+b.dataset.i, 1); renderDocLib(); }; });
  var sv = root.querySelector("[data-utmrsave]");
  if (sv) sv.onclick = function () {
    var n = normalizeUtmRules(D);
    if (!n.sources.length || !n.mediums.length || !n.products.length) { toast("Keep at least one source, medium and product"); return; }
    n.sources.forEach(function (s) { s.mediums = s.mediums.filter(function (m) { return !!utmFind(n.mediums, m); }); });
    n.updatedBy = dlMe(); n.updatedAt = dlToday();
    UTM_RULES = n; UTM_UI.draft = null; utmSave(); renderDocLib(); toast("Rules saved — everyone’s builder uses them now");
  };
  var cc = root.querySelector("[data-utmrcancel]"); if (cc) cc.onclick = function () { UTM_UI.draft = null; renderDocLib(); };
  var df = root.querySelector("[data-utmrdef]");
  if (df) df.onclick = function () { if (window.confirm("Replace the rules on screen with the starter rules? Nothing is saved until you press Save rules.")) { UTM_UI.draft = JSON.parse(JSON.stringify(UTM_DEFAULTS)); renderDocLib(); } };
}
