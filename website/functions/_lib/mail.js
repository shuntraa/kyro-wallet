// SPDX-License-Identifier: GPL-3.0-or-later
// Builds the outgoing email: the sign-off is added here, at send time, and is never part of what is typed.

const ADDRESS = /^[^\s@<>"',;()[\]\\]+@[^\s@<>"',;()[\]\\]+\.[^\s@<>"',;()[\]\\]{2,}$/;

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// "a@b.com, c@d.com" -> { ok, list } or { ok: false, error }. 1 to 5 addresses, no duplicates.
export function parseRecipients(raw) {
  if (typeof raw !== "string") return { ok: false, error: "Destinataire manquant." };
  const list = [...new Set(raw.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (!list.length) return { ok: false, error: "Destinataire manquant." };
  if (list.length > 5) return { ok: false, error: "5 destinataires maximum." };
  const bad = list.find((a) => a.length > 254 || !ADDRESS.test(a));
  if (bad) return { ok: false, error: `Adresse invalide : ${bad}` };
  return { ok: true, list };
}

export function cleanSubject(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\r\n\t]+/g, " ").trim();
  return s.length >= 1 && s.length <= 200 ? s : null;
}

export function cleanBody(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\r\n?/g, "\n").trim();
  return s.length >= 1 && s.length <= 20000 ? s : null;
}

export function buildMessage(sender, body) {
  const text = `${body}\n\nBest regards,\n${sender.team}\nKyro Wallet | kyrowallet.com\n${sender.address}\n`;
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111">` +
    `<div>${escapeHtml(body).replace(/\n/g, "<br>")}</div>` +
    `<div style="margin-top:24px">Best regards,<br>${escapeHtml(sender.team)}<br>` +
    `Kyro Wallet | <a href="https://kyrowallet.com">kyrowallet.com</a><br>` +
    `<a href="mailto:${escapeHtml(sender.address)}">${escapeHtml(sender.address)}</a></div>` +
    `</div>`;
  return { text, html };
}
