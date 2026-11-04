// SPDX-License-Identifier: GPL-3.0-or-later
// Last known balances and prices, kept on this device so the portfolio shows something right away
// on the next launch while the network (Tor) is still loading. Amounts and prices only: no keys,
// no addresses (the wallet is identified by a hash of its account list).

import type { HistoryItem } from '@kyro/chains';
import type { SimplePrice } from '@kyro/market';
import { readJson, scoped, writeJson } from './storage';

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
  return decodeBalances(readJson<unknown>(scoped(`cache.balances.${network}`), null), fp);
}
export function saveBalances(network: string, fp: string, m: Balances): void {
  if (m.size > 0) writeJson(scoped(`cache.balances.${network}`), encodeBalances(fp, m));
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

// --- History -------------------------------------------------------------------------------------
// Last known activity per account and chain, so the History screen and the asset activity cards
// render at once; the network refresh then merges in what changed. Transaction metadata only
// (ids, amounts, counterparties, times): never a key or a seed.

/** One account's history on one chain: `<family>:<account index>:<chain key>`. */
export type HistoryCache = Map<string, HistoryItem[]>;

/** Items kept per account and chain. */
export const HISTORY_CACHE_MAX = 200;
const HKEY_RE = /^[a-z0-9]{1,16}:\d{1,4}:[\w.-]{1,64}$/;
const DIRS = new Set(['in', 'out', 'self']);
const STATUSES = new Set(['pending', 'confirmed', 'failed']);
const KINDS = new Set(['transfer', 'swap', 'approval', 'contract']);

export function historyKey(family: string, index: number, chainKey: string): string {
  return `${family}:${index}:${chainKey}`;
}

/** Newest first; pending items without a time first of all. */
function byTime(a: HistoryItem, b: HistoryItem): number {
  return (b.time ?? Number.MAX_SAFE_INTEGER) - (a.time ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Merges a fresh fetch into the cached list. The fetch is authoritative for the period it covers
 * (from its oldest dated item to now: a cached pending item it no longer lists is dropped, a
 * confirmed one replaces it); cached items older than that period are kept. Deduplicated by id,
 * newest first, capped at `max`.
 */
export function mergeHistory(cached: readonly HistoryItem[] | undefined, fresh: readonly HistoryItem[], max = HISTORY_CACHE_MAX): HistoryItem[] {
  const out = new Map<string, HistoryItem>();
  for (const x of fresh) if (!out.has(x.id)) out.set(x.id, x);
  const times = fresh.map((x) => x.time).filter((t): t is number => typeof t === 'number');
  if (cached && times.length > 0) {
    const oldest = Math.min(...times);
    for (const x of cached) if (!out.has(x.id) && typeof x.time === 'number' && x.time < oldest) out.set(x.id, x);
  }
  return [...out.values()].sort(byTime).slice(0, max);
}

/** Newest dated item of a list (what a refresh needs to be "new"). */
export function newestTime(items: readonly HistoryItem[] | undefined): number | null {
  let best: number | null = null;
  for (const x of items ?? []) if (typeof x.time === 'number' && (best === null || x.time > best)) best = x.time;
  return best;
}

interface StoredItem {
  i: string;
  c: string;
  a: string;
  d: string;
  m: string;
  f?: string;
  p?: string;
  t?: number;
  s: string;
  k: string;
  n?: string;
  x?: string;
}
interface StoredHistory {
  fp: string;
  h: Record<string, StoredItem[]>;
}

export function encodeHistory(fp: string, m: HistoryCache): StoredHistory {
  const h: StoredHistory['h'] = {};
  m.forEach((items, key) => {
    h[key] = items.slice(0, HISTORY_CACHE_MAX).map((x) => {
      const o: StoredItem = { i: x.id, c: x.chainKey, a: x.assetId, d: x.direction, m: x.amount.toString(), s: x.status, k: x.kind };
      if (x.fee !== undefined) o.f = x.fee.toString();
      if (x.counterparty !== undefined) o.p = x.counterparty;
      if (x.time !== undefined) o.t = x.time;
      if (x.note !== undefined) o.n = x.note;
      if (x.suspect !== undefined) o.x = x.suspect;
      return o;
    });
  });
  return { fp, h };
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function decodeItem(raw: unknown): HistoryItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Record<keyof StoredItem, unknown>>;
  if (!str(r.i, 300) || !str(r.c, 64) || !ID_RE.test(String(r.a)) || !DIRS.has(String(r.d)) || !str(r.m, 78) || !AMOUNT_RE.test(r.m) || !STATUSES.has(String(r.s)) || !KINDS.has(String(r.k))) return null;
  const x: HistoryItem = { id: r.i, chainKey: r.c, assetId: String(r.a), direction: r.d as HistoryItem['direction'], amount: BigInt(r.m), status: r.s as HistoryItem['status'], kind: r.k as HistoryItem['kind'] };
  if (str(r.f, 78) && AMOUNT_RE.test(r.f)) x.fee = BigInt(r.f);
  if (str(r.p, 300)) x.counterparty = r.p;
  if (typeof r.t === 'number' && Number.isFinite(r.t) && r.t > 0) x.time = r.t;
  if (str(r.n, 500)) x.note = r.n;
  if (r.x === 'zero' || r.x === 'notSigned') x.suspect = r.x;
  return x;
}

/** Shape-checked read back; null when absent, malformed or for another wallet. */
export function decodeHistory(raw: unknown, fp: string): HistoryCache | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<StoredHistory>;
  if (r.fp !== fp || !r.h || typeof r.h !== 'object') return null;
  const out: HistoryCache = new Map();
  for (const [k, items] of Object.entries(r.h)) {
    if (!HKEY_RE.test(k) || !Array.isArray(items)) continue;
    const list = items.map(decodeItem).filter((x): x is HistoryItem => x !== null);
    out.set(k, list.sort(byTime).slice(0, HISTORY_CACHE_MAX));
  }
  return out;
}

/** One history cache per wallet (account-list fingerprint) and network: switching wallets keeps each one's list. */
export function loadHistory(network: string, fp: string): HistoryCache | null {
  return decodeHistory(readJson<unknown>(`cache.history.${network}.${fp}`, null), fp) ?? decodeHistory(readJson<unknown>(`cache.history.${network}`, null), fp);
}
export function saveHistory(network: string, fp: string, m: HistoryCache): void {
  if (m.size > 0) writeJson(`cache.history.${network}.${fp}`, encodeHistory(fp, m));
}
