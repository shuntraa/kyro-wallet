// SPDX-License-Identifier: GPL-3.0-or-later
// GET /api/stats: the public usage counters (weekly active wallets, total downloads) for the site's pages.
// The stats workflow (.github/workflows/stats.yml) writes them every hour to the `stats` branch; this reads
// that file server side, so visitors' browsers only ever talk to kyrowallet.com. Cloudflare keeps the
// upstream answer 60 s at the edge. Nothing about the visitor is read or stored.

const SOURCE = "https://raw.githubusercontent.com/shuntraa/kyro-wallet/stats/stats/stats.json";

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const count = (v) => (typeof v === "number" && isFinite(v) && v > 0 ? Math.floor(v) : 0);

export async function onRequestGet() {
  try {
    const r = await fetch(SOURCE, { cf: { cacheTtl: 60, cacheEverything: true }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(String(r.status));
    const s = await r.json();
    const body = { weekly_active: count(s && s.weekly_active), downloads_total: count(s && s.downloads_total) };
    return new Response(JSON.stringify(body), { headers: HEADERS });
  } catch {
    return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: HEADERS });
  }
}
