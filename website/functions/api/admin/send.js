// SPDX-License-Identifier: GPL-3.0-or-later
import { SENDERS, resendKey } from "../../_lib/config.js";
import { guard, json, readJson } from "../../_lib/http.js";
import { buildMessage, cleanBody, cleanSubject, parseRecipients } from "../../_lib/mail.js";

export const onRequestPost = guard(async ({ request, env }) => {
  const apiKey = resendKey(env);
  if (!apiKey) return json({ error: "Secret RESEND manquant dans les variables Cloudflare Pages." }, 500);

  let data;
  try {
    data = await readJson(request);
  } catch {
    return json({ error: "Requête invalide." }, 400);
  }

  // The sender can only be one of the four addresses in config.js, never a free value.
  const sender = Object.hasOwn(SENDERS, data.from) ? SENDERS[data.from] : null;
  if (!sender) return json({ error: "Adresse d'envoi inconnue." }, 400);

  const to = parseRecipients(data.to);
  if (!to.ok) return json({ error: to.error }, 400);
  const subject = cleanSubject(data.subject);
  if (!subject) return json({ error: "Objet manquant (200 caractères max)." }, 400);
  const body = cleanBody(data.body);
  if (!body) return json({ error: "Message vide (20 000 caractères max)." }, 400);

  const { text, html } = buildMessage(sender, body);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": "kyroweb-admin/1.0",
  };
  // A double tap or a retry with the same id sends the email once.
  if (typeof data.requestId === "string" && /^[A-Za-z0-9-]{8,64}$/.test(data.requestId)) {
    headers["Idempotency-Key"] = `kyro-admin-${data.requestId}`;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify({
      from: `${sender.name} <${sender.address}>`,
      to: to.list,
      reply_to: sender.address,
      subject,
      text,
      html,
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: out.message || `Resend a refusé l'envoi (${res.status}).` }, 502);
  return json({ ok: true, id: out.id || null, to: to.list });
});
