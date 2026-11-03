// SPDX-License-Identifier: GPL-3.0-or-later
// Kraken's weekly USD closes for the « All » chart, kept on this device and refreshed weekly (the
// past does not change). Public prices only.

import { krakenPair, krakenWeekly, mergeLongHistory, type ChartDays, type ChartPoint } from '@kyro/market';
import { readJson, writeJson } from './storage';

const WEEK = 7 * 86_400_000;
const DAY = 86_400_000;

/** Whether the coin has a long source: without one, « All » would only repeat 1Y and is hidden. */
export const hasLongHistory = (coinId: string): boolean => krakenPair(coinId) !== null;

export async function longUsd(pair: string, now = Date.now()): Promise<ChartPoint[]> {
  const key = `cache.kraken.${pair}`;
  const c = readJson<{ t?: unknown; p?: unknown } | null>(key, null);
  const cached = c && typeof c.t === 'number' && Array.isArray(c.p) ? (c.p as ChartPoint[]) : null;
  if (cached && c && now - (c.t as number) < WEEK) return cached;
  try {
    const p = await krakenWeekly(pair);
    if (p.length > 0) writeJson(key, { t: now, p: p.map(([t, v]) => [t, Number(v.toPrecision(7))]) });
    return p.length > 0 ? p : (cached ?? []);
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}

/**
 * The « All » fetcher: CoinGecko's recent series, joined to Kraken's long one when the cached
 * series does not reach back further than a year yet (a small refresh otherwise).
 */
export function allTimeFetcher(coinId: string, recent: (days: ChartDays) => Promise<ChartPoint[]>, cachedFirst: number | undefined, now = Date.now()): (days: ChartDays) => Promise<ChartPoint[]> {
  const pair = krakenPair(coinId);
  return async (days) => {
    if (!pair || (days !== 'max' && cachedFirst !== undefined && cachedFirst < now - 400 * DAY)) return recent(days);
    const full = await recent(days === 'max' ? 'max' : 365);
    const long = await longUsd(pair, now).catch(() => [] as ChartPoint[]);
    return mergeLongHistory(long, full);
  };
}
