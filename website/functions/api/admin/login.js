// SPDX-License-Identifier: GPL-3.0-or-later
import { adminConfigured, checkLogin, createSession, sessionCookie } from "../../_lib/auth.js";
import { guard, json, readJson } from "../../_lib/http.js";

export const onRequestPost = guard(
  async ({ request, env }) => {
    let data;
    try {
      data = await readJson(request, 2000);
    } catch {
      return json({ error: "Requête invalide." }, 400);
    }
    if (!adminConfigured(env)) {
      return json({ error: "Secrets ADMIN_USER / ADMIN_PASSWORD / ADMIN_SESSION_SECRET manquants ou trop courts dans Cloudflare Pages." }, 500);
    }
    const ok = await checkLogin(env, data.user, data.password);
    if (!ok) {
      await new Promise((r) => setTimeout(r, 600)); // slows down guessing
      return json({ error: "Identifiant ou mot de passe incorrect." }, 401);
    }
    const token = await createSession(env, String(data.user));
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
  },
  { auth: false },
);
