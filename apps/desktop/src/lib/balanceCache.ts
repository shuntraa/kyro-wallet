// SPDX-License-Identifier: GPL-3.0-or-later
// Last known balances and prices, kept on this device so the portfolio shows something right away
// on the next launch while the network (Tor) is still loading. Amounts and prices only: no keys,
// no addresses (the wallet is identified by a hash of its account list).

import type { SimplePrice } from '@kyro/market';
import { readJson, writeJson } from './storage';

/** How long a chain may keep failing (automatic retries included) before the UI says anything. */
export const ERROR_GRACE_MS = 180_000;

/** FNV-1a 32-bit, hex: tells two account lists apart without storing them. */
export function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

type Balances = Map<string, Map<string, bigint>>;
interface StoredBalances {
  fp: string;
  b: Record<string, Record<string, string>>;
}

const KEY_RE = /^[a-z0-9]{1,16}:\d{1,4}$/;
const ID_RE = /^\S{1,200}$/;
const AMOUNT_RE = /^\d{1,78}$/;

export function encodeBalances(fp: string, m: Balances): StoredBalances {
  const b: StoredBalances['b'] = {};
  m.forEach((assets, k) => {
    const o: Record<string, string> = {};
    assets.forEach((v, id) => {
      if (v >= 0n) o[id] = v.toString();
    });
    b[k] = o;
  });
  return { fp, b };
}

/** Shape-checked read back; null when absent, malformed or for another wallet. */
export function decodeBalances(raw: unknown, fp: string): Balances | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<StoredBalances>;
  if (r.fp !== fp || !r.b || typeof r.b !== 'object') return null;
  const out: Balances = new Map();
  for (const [k, assets] of Object.entries(r.b)) {
    if (!KEY_RE.test(k) || !assets || typeof assets !== 'object') continue;
    const m = new Map<string, bigint>();
    for (const [id, v] of Object.entries(assets as Record<string, unknown>)) if (ID_RE.test(id) && typeof v === 'string' && AMOUNT_RE.test(v)) m.set(id, BigInt(v));
    out.set(k, m);
  }
  return out.size > 0 ? out : null;
}

export function loadBalances(network: string, fp: string): Balances | null {
  return decodeBalances(readJson<unknown>(`cache.balances.${network}`, null), fp);
}
export function saveBalances(network: string, fp: string, m: Balances): void {
  if (m.size > 0) writeJson(`cache.balances.${network}`, encodeBalances(fp, m));
}

export function decodePrices(raw: unknown): Record<string, SimplePrice> {
  const out: Record<string, SimplePrice> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ID_RE.test(id) || !v || typeof v !== 'object') continue;
    const { price, change24h } = v as { price?: unknown; change24h?: unknown };
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) continue;
    out[id] = { price, change24h: typeof change24h === 'number' && Number.isFinite(change24h) ? change24h : null };
  }
  return out;
}
export function loadPrices(currency: string): Record<string, SimplePrice> {
  return decodePrices(readJson<unknown>(`cache.prices.${currency}`, null));
}
export function savePrices(currency: string, prices: Record<string, SimplePrice>): void {
  if (Object.keys(prices).length > 0) writeJson(`cache.prices.${currency}`, prices);
}

/**
 * Errors shown to the user: only chains that have kept failing for `grace` ms (first load and
 * automatic retries stay silent). `since` is when each chain started failing; returns the updated
 * map (chains that answered again are dropped).
 */
export function settleErrors(errors: Record<string, string>, since: Record<string, number>, now: number, grace = ERROR_GRACE_MS): { visible: Record<string, string>; since: Record<string, number> } {
  const nextSince: Record<string, number> = {};
  const visible: Record<string, string> = {};
  for (const [k, msg] of Object.entries(errors)) {
    const t = since[k] ?? now;
    nextSince[k] = t;
    if (now - t >= grace) visible[k] = msg;
  }
  return { visible, since: nextSince };
}
