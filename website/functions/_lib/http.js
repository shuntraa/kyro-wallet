// SPDX-License-Identifier: GPL-3.0-or-later
// Shared request guard for the admin API. Every handler goes through guard(), so none can forget the checks.
import { readSession } from "./auth.js";

const BASE = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...BASE, ...extra } });
}

export async function readJson(request, maxChars = 80000) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxChars * 4) throw new Error("too large");
  const text = await request.text();
  if (text.length > maxChars) throw new Error("too large");
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("bad body");
  return data;
}

// auth: true  -> a valid session cookie is required (401 otherwise)
// Writes (POST) must come from this same site and carry JSON, which a cross-site form cannot send.
export function guard(handler, { auth = true } = {}) {
  return async (ctx) => {
    const { request, env } = ctx;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== new URL(request.url).origin) return json({ error: "Origine refusée." }, 403);
      const type = (request.headers.get("Content-Type") || "").toLowerCase();
      if (!type.startsWith("application/json")) return json({ error: "Format invalide." }, 415);
    }
    let session = null;
    if (auth) {
      session = await readSession(request, env);
      if (!session) return json({ error: "Non connecté." }, 401);
    }
    try {
      return await handler({ ...ctx, session });
    } catch {
      return json({ error: "Erreur serveur." }, 500);
    }
  };
}
