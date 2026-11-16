// SPDX-License-Identifier: GPL-3.0-or-later
// Admin mailer settings. The only Cloudflare variable you must set is the secret RESEND (your Resend API key).

export const DOMAIN = "kyrowallet.com";

// The four sending addresses. id = what the page sends, name = the sender name people see,
// team = the line that signs the bottom of the email (added when it is sent, never shown while writing).
export const SENDERS = {
  contact:  { address: "contact@" + DOMAIN,  name: "Kyro",          team: "Kyro Team" },
  support:  { address: "support@" + DOMAIN,  name: "Kyro Support",  team: "Kyro Support Team" },
  business: { address: "business@" + DOMAIN, name: "Kyro Business", team: "Kyro Business Team" },
  report:   { address: "report@" + DOMAIN,   name: "Kyro Report",   team: "Kyro Security Team" },
};

// No login is stored in the code. Three Cloudflare Pages secrets are required:
//   ADMIN_USER, ADMIN_PASSWORD (16+ characters) and ADMIN_SESSION_SECRET (32+ random characters).
// If one is missing or too short, every login is refused.
export const MIN_PASSWORD = 16;
export const MIN_SESSION_SECRET = 32;

export const SESSION_HOURS = 12;

// The Resend key lives in the Cloudflare secret named RESEND (RESEND_API_KEY works too).
export const resendKey = (env) => env.RESEND || env.RESEND_API_KEY || "";
