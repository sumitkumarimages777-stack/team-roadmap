// Cyberflow — webhook receiver (Vercel serverless function)
// Deploy: put this file at  api/webhook.js  in your repo root (next to index.html).
// Vercel auto-exposes it at   https://YOURAPP.vercel.app/api/webhook
//
// One-time setup — in Vercel → Project → Settings → Environment Variables, add:
//   JSONBIN_BIN = 6a846405f5f4af5e292489c5   (your forms/inbox bin id)
//   JSONBIN_KEY = <your JSONBin Master Key>   (kept here on the server, NOT in the public app)
//
// Then point any app's webhook at:  https://YOURAPP.vercel.app/api/webhook?tag=signups
// Each POST is stored as an event; the app reads the latest event for that tag.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const BIN = process.env.JSONBIN_BIN;
  const KEY = process.env.JSONBIN_KEY;
  if (!BIN || !KEY) return res.status(500).json({ error: "Set JSONBIN_BIN and JSONBIN_KEY env vars in Vercel" });

  const tag = (req.query && req.query.tag) ? String(req.query.tag).slice(0, 60) : "default";
  let payload = req.body;
  if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch (e) { /* keep as string */ } }

  try {
    const r = await fetch("https://api.jsonbin.io/v3/b/" + BIN + "/latest",
      { headers: { "X-Master-Key": KEY, "X-Bin-Meta": "false" } });
    let rec = r.ok ? await r.json() : {};
    if (!rec || typeof rec !== "object") rec = {};
    rec.webhookEvents = Array.isArray(rec.webhookEvents) ? rec.webhookEvents : [];
    rec.webhookEvents.push({
      id: "wh-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      at: new Date().toISOString(),
      tag: tag,
      payload: payload
    });
    if (rec.webhookEvents.length > 200) rec.webhookEvents = rec.webhookEvents.slice(-200);
    const w = await fetch("https://api.jsonbin.io/v3/b/" + BIN,
      { method: "PUT", headers: { "Content-Type": "application/json", "X-Master-Key": KEY }, body: JSON.stringify(rec) });
    if (!w.ok) return res.status(502).json({ error: "Inbox write failed: " + w.status });
    return res.status(200).json({ ok: true, tag: tag });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
