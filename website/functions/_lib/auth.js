// SPDX-License-Identifier: GPL-3.0-or-later
// Auth helpers for the admin mailer. Web Crypto only: runs on Cloudflare Pages Functions and on Node 20+.
import { MIN_PASSWORD, MIN_SESSION_SECRET, SESSION_HOURS } from "./config.js";

const enc = new TextEncoder();
const COOKIE = "__Host-kyro_admin";
const CONTEXT = "kyro-admin-session-v1.";

export const b64u = {
  enc(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str) {
    const p = String(str).replace(/-/g, "+").replace(/_/g, "/");
    const s = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

function eqBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// Compares two strings without leaking where they differ (or how long they are).
export async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  return eqBytes(ha, hb);
}

// True only when the three admin secrets are set and long enough. Otherwise nobody can log in.
export function adminConfigured(env) {
  return (
    typeof env.ADMIN_USER === "string" && env.ADMIN_USER.length > 0 &&
    typeof env.ADMIN_PASSWORD === "string" && env.ADMIN_PASSWORD.length >= MIN_PASSWORD &&
    typeof env.ADMIN_SESSION_SECRET === "string" && env.ADMIN_SESSION_SECRET.length >= MIN_SESSION_SECRET
  );
}

// The user and the password are always both checked, so a wrong user and a wrong password take the same time.
export async function checkLogin(env, user, password) {
  if (!adminConfigured(env)) return false;
  if (typeof user !== "string" || typeof password !== "string") return false;
  if (user.length > 100 || password.length > 200) return false;
  const [userOk, passOk] = await Promise.all([safeEqual(user, env.ADMIN_USER), safeEqual(password, env.ADMIN_PASSWORD)]);
  return userOk && passOk;
}

// Sessions are signed with their own secret, never with the Resend key.
function secretOf(env) {
  return adminConfigured(env) ? env.ADMIN_SESSION_SECRET : "";
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function createSession(env, user) {
  const secret = secretOf(env);
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
  const payload = b64u.enc(enc.encode(JSON.stringify({ u: user, exp })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(CONTEXT + payload));
  return `${payload}.${b64u.enc(new Uint8Array(sig))}`;
}

function cookieValue(request) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return "";
}

export async function readSession(request, env) {
  try {
    const secret = secretOf(env);
    const token = cookieValue(request);
    if (!secret || !token) return null;
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64u.dec(sig), enc.encode(CONTEXT + payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64u.dec(payload)));
    if (!data || typeof data.exp !== "number" || data.exp < Math.floor(Date.now() / 1000)) return null;
    return { user: String(data.u) };
  } catch {
    return null;
  }
}

export function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_HOURS * 3600}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
