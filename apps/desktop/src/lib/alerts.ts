// SPDX-License-Identifier: GPL-3.0-or-later
// Local alerts: what the user asked to be told about, and when it is true. Pure logic on data the
// app already holds (market prices, cached history); nothing here touches the network.

import type { Currency } from '@kyro/shared';
import { readJson, writeJson } from './storage';

export type AlertDirection = 'above' | 'below';

export interface PriceAlert {
  id: string;
  /** CoinGecko id, as in `usePortfolio().price`. */
  coinId: string;
  symbol: string;
  direction: AlertDirection;
  level: number;
  /** The level means nothing in another currency: the rule sleeps until this one is back. */
  currency: Currency;
  /** Fires on the next pass beyond the level. False once fired, until the price comes back. */
  armed: boolean;
}

export interface AlertSettings {
  received: boolean;
  prices: PriceAlert[];
}

export const MAX_PRICE_ALERTS = 50;
/** The price must come back this far past the level before the alert can fire again. */
export const REARM_MARGIN = 0.01;
/** New funds notified per pass; a wallet opened after a long time does not get a wall of them. */
export const MAX_RECEIVED_PER_PASS = 3;
const MAX_SEEN = 1000;

const KEY = 'alerts.settings';

function isPriceAlert(x: unknown): x is PriceAlert {
  const r = x as PriceAlert;
  return !!r && typeof r.id === 'string' && typeof r.coinId === 'string' && typeof r.symbol === 'string' && (r.direction === 'above' || r.direction === 'below') && Number.isFinite(r.level) && r.level > 0 && typeof r.currency === 'string' && typeof r.armed === 'boolean';
}

export function getAlertSettings(): AlertSettings {
  const v = readJson<Partial<AlertSettings> | null>(KEY, null);
  return { received: v?.received === true, prices: Array.isArray(v?.prices) ? v.prices.filter(isPriceAlert).slice(0, MAX_PRICE_ALERTS) : [] };
}

export function saveAlertSettings(s: AlertSettings): void {
  writeJson(KEY, s);
}

/** A level typed by the user ("70 000,50"): a positive number, or null. */
export function parseLevel(input: string): number | null {
  const s = input.replace(/[\s  ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) && v > 0 ? v : null;
}

const past = (r: PriceAlert, price: number): boolean => (r.direction === 'above' ? price >= r.level : price <= r.level);
const backInside = (r: PriceAlert, price: number): boolean => (r.direction === 'above' ? price < r.level * (1 - REARM_MARGIN) : price > r.level * (1 + REARM_MARGIN));

export interface PriceHit {
  rule: PriceAlert;
  price: number;
}

/** One market update: which rules fire, and the rules after it. A missing price changes nothing. */
export function evaluatePrices(rules: readonly PriceAlert[], priceOf: (coinId: string) => number | null, currency: Currency): { rules: PriceAlert[]; hits: PriceHit[] } {
  const hits: PriceHit[] = [];
  const next = rules.map((r) => {
    const price = r.currency === currency ? priceOf(r.coinId) : null;
    if (price === null || !Number.isFinite(price) || price <= 0) return r;
    if (r.armed && past(r, price)) {
      const fired = { ...r, armed: false };
      hits.push({ rule: fired, price });
      return fired;
    }
    return !r.armed && backInside(r, price) ? { ...r, armed: true } : r;
  });
  return { rules: next, hits };
}

export interface ReceivedState {
  /** Chain → when it was first looked at. What is older than that was never news. */
  baselines: Record<string, number>;
  seen: string[];
}

export const emptyReceived = (): ReceivedState => ({ baselines: {}, seen: [] });

export interface ReceivableEntry {
  id: string;
  chainKey: string;
  kind: string;
  direction: string;
  status: string;
  amount: bigint;
  time?: number;
  suspect?: unknown;
}

/** Only funds that really arrived: confirmed (a pending payment can still vanish), not a poisoning lure. */
const isReceipt = (e: ReceivableEntry): boolean => e.kind === 'transfer' && e.direction === 'in' && e.status === 'confirmed' && e.amount > 0n && !e.suspect;

/**
 * One look at the history. A chain seen for the first time only sets its baseline: what it already
 * holds is the past. `chains` lists the chains with a known answer, so a network that was
 * unreachable for days is not mistaken for new funds when it answers.
 */
export function evaluateReceived<T extends ReceivableEntry>(entries: readonly T[], chains: readonly string[], state: ReceivedState, now: number): { state: ReceivedState; hits: T[] } {
  const baselines = { ...state.baselines };
  const seen = new Set(state.seen);
  const fresh = new Set(chains.filter((c) => baselines[c] === undefined));
  for (const c of fresh) baselines[c] = now;
  const hits: T[] = [];
  for (const e of entries) {
    if (!isReceipt(e) || seen.has(e.id)) continue;
    const baseline = baselines[e.chainKey];
    if (baseline === undefined) continue; // chain not answered yet: decide when it has
    seen.add(e.id);
    if (fresh.has(e.chainKey) || (e.time !== undefined && e.time < baseline)) continue;
    if (hits.length < MAX_RECEIVED_PER_PASS) hits.push(e);
  }
  return { state: { baselines, seen: [...seen].slice(-MAX_SEEN) }, hits };
}
