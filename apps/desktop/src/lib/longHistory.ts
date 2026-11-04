// SPDX-License-Identifier: GPL-3.0-or-later
// Kraken's weekly USD prices for the « All » chart, kept on this device and refreshed weekly (the
// past does not change). « All » is the 1Y series extended to the left with them: the chart never
// waits for this request. Public prices only.

import { krakenPair, krakenWeekly, type ChartPoint } from '@kyro/market';
import { dropSavedAll, mergeSeries, remove } from './chartCache';
import { Dedupe } from './dedupe';
import { readJson, writeJson } from './storage';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** A long series starts at least this far back: anything shorter only repeats 1Y. */
const LONG_MIN_SPAN = 400 * DAY;
/** Pause between two coins of the background warm-up. */
const WARM_GAP_MS = 2_000;

/** Whether the coin has a long source: without one, « All » would only repeat 1Y and is hidden. */
export const hasLongHistory = (coinId: string): boolean => krakenPair(coinId) !== null;

const key = (pair: string) => `cache.kraken.${pair}`;
const loads = new Dedupe(0);

const isLong = (points: readonly ChartPoint[], now: number): boolean => {
  const first = points[0];
  return first !== undefined && first[0] < now - LONG_MIN_SPAN;
};

function saved(pair: string, now: number): { t: number; points: ChartPoint[] } | null {
  const c = readJson<{ t?: unknown; p?: unknown } | null>(key(pair), null);
  if (!c || typeof c.t !== 'number' || !Array.isArray(c.p)) return null;
  const points = c.p as ChartPoint[];
  if (isLong(points, now)) return { t: c.t, points };
  remove(key(pair));
  return null;
}

/** The series kept on this device, whatever its age, without the network. */
export const peekLong = (pair: string, now = Date.now()): ChartPoint[] | null => saved(pair, now)?.points ?? null;

/**
 * The long series: the saved one for a week, else Kraken's (the saved one if Kraken fails). Older
 * saved weeks are kept: Kraken answers the last 720 weeks only, which will soon be less than BTC's.
 */
export function longUsd(pair: string, now = Date.now()): Promise<ChartPoint[]> {
  const c = saved(pair, now);
  if (c && now - c.t < WEEK) return Promise.resolve(c.points);
  return loads.run(pair, async () => {
    try {
      const answer = await krakenWeekly(pair);
      const p = mergeSeries(c?.points, answer);
      if (!isLong(p, now)) return p;
      writeJson(key(pair), { t: now, p: p.map(([t, v]) => [t, Number(v.toPrecision(7))]) });
      return p;
    } catch (e) {
      if (c) return c.points;
      throw e;
    }
  });
}

/**
 * Fetches the long series of the held coins, one at a time (low priority: balances and charts on
 * screen go first). Fresh coins cost no request; a failure waits for the next round.
 */
export async function warmLongHistory(coinIds: readonly string[], alive: () => boolean, gapMs = WARM_GAP_MS, now: () => number = Date.now): Promise<void> {
  dropSavedAll();
  for (const id of coinIds) {
    const pair = krakenPair(id);
    if (!alive()) return;
    if (!pair) continue;
    const c = saved(pair, now());
    if (c && now() - c.t < WEEK) continue;
    await longUsd(pair, now()).catch(() => undefined);
    await new Promise((r) => setTimeout(r, gapMs));
  }
}
