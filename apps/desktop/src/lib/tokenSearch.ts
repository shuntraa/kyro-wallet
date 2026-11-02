// SPDX-License-Identifier: GPL-3.0-or-later
// Swap token picker: search by ticker, name (and former names) or network, recent then popular first.

import { COIN_RENAMES } from '@kyro/chains';
import { readJson, writeJson } from './storage';

export interface PickerEntry {
  id: string;
  symbol: string;
  name: string;
  /** Network label shown as a badge (« Ethereum », « XMR »…) and its chain name. */
  network: string;
  networkName?: string;
  coingeckoId?: string;
  /** Held amount > 0 (ranks above the coins you don't hold). */
  held?: boolean;
  disabled?: boolean;
}

/** Most traded first (ticker order) when nothing is typed and nothing was picked recently. */
export const POPULAR_TICKERS: readonly string[] = ['BTC', 'ETH', 'USDT', 'USDC', 'SOL', 'XMR', 'BNB', 'XRP', 'TRX', 'DOGE', 'ADA', 'LTC', 'TON', 'GRAM', 'AVAX', 'POL', 'SUI', 'ZEC', 'KAS', 'NEAR', 'ALGO', 'APT', 'XLM', 'BCH', 'DASH', 'DAI'];

/**
 * Match quality of `e` for the lower-cased, trimmed query `q` (0 = no match): exact ticker, ticker
 * prefix, name prefix, ticker / name substring, former name, then network.
 */
export function matchScore(e: PickerEntry, q: string): number {
  if (!q) return 1;
  const sym = e.symbol.toLowerCase();
  const name = e.name.toLowerCase();
  if (sym === q) return 100;
  if (sym.startsWith(q)) return 80;
  if (name.startsWith(q) || name.split(/[\s-]+/).some((w) => w.startsWith(q))) return 60;
  if (sym.includes(q) || name.includes(q)) return 40;
  const r = e.coingeckoId ? COIN_RENAMES[e.coingeckoId] : undefined;
  if (r?.aliases.some((a) => a.startsWith(q))) return 35;
  const net = `${e.network} ${e.networkName ?? ''}`.toLowerCase();
  if (net.split(/[\s-]+/).some((w) => w.startsWith(q))) return 20;
  return 0;
}

/** Entries matching `query`, best first; ties: recent, held, popular, then the original order. Greyed entries last. */
export function searchTokens<T extends PickerEntry>(entries: readonly T[], query: string, recent: readonly string[] = []): T[] {
  const q = query.trim().toLowerCase();
  const pop = (e: T) => {
    const i = POPULAR_TICKERS.indexOf(e.symbol.toUpperCase());
    return i < 0 ? POPULAR_TICKERS.length : i;
  };
  const rec = (e: T) => {
    const i = recent.indexOf(e.id);
    return i < 0 ? recent.length : i;
  };
  return entries
    .map((e, i) => ({ e, i, s: matchScore(e, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => Number(!!a.e.disabled) - Number(!!b.e.disabled) || b.s - a.s || rec(a.e) - rec(b.e) || Number(!!b.e.held) - Number(!!a.e.held) || pop(a.e) - pop(b.e) || a.i - b.i)
    .map((x) => x.e);
}

const RECENT_KEY = 'swapRecentTokens';
const RECENT_MAX = 8;

export function getRecentTokens(): string[] {
  const v = readJson<unknown>(RECENT_KEY, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
}

export function pushRecentToken(id: string): string[] {
  const next = [id, ...getRecentTokens().filter((x) => x !== id)].slice(0, RECENT_MAX);
  writeJson(RECENT_KEY, next);
  return next;
}
