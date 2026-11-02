// SPDX-License-Identifier: GPL-3.0-or-later
// Price history kept on this device, per coin, currency and period, so an asset's chart shows at
// once; a refresh then asks only for the recent part it misses and merges it in. Public market
// prices only. Old points are thinned (never more than `CHART_MAX_POINTS` per series) and only the
// most recently opened coins are kept.

import type { ChartDays, ChartPoint } from '@kyro/market';
import { readJson, writeJson } from './storage';

export type ChartPeriod = '1J' | '1S' | '1M' | '1A' | 'Tout';

const DAY = 86_400_000;
export const PERIOD_MS: Record<ChartPeriod, number> = { '1J': DAY, '1S': 7 * DAY, '1M': 30 * DAY, '1A': 365 * DAY, Tout: Number.POSITIVE_INFINITY };
const PERIOD_DAYS: Record<ChartPeriod, ChartDays> = { '1J': 1, '1S': 7, '1M': 30, '1A': 365, Tout: 'max' };
/** Below this age the last point is recent enough: no request at all. */
const FRESH_MS: Record<ChartPeriod, number> = { '1J': 3 * 60_000, '1S': 15 * 60_000, '1M': 30 * 60_000, '1A': 2 * 3_600_000, Tout: 6 * 3_600_000 };
/** A cached series that starts this much after the period's start does not cover it. */
const COVER_SLACK = 0.05;

export const CHART_MAX_POINTS = 400;
/** Coins (per currency) whose charts are kept. */
export const CHART_MAX_COINS = 24;

const COIN_RE = /^[a-z0-9-]{1,100}$/;
const CUR_RE = /^[a-z]{3,5}$/;

function valid(p: unknown): p is ChartPoint {
  return Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number' && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] > 0 && p[1] >= 0;
}

/** Sorted by time, one point per timestamp (the later one wins). */
function normalise(points: readonly ChartPoint[]): ChartPoint[] {
  const byT = new Map<number, number>();
  for (const p of points) if (valid(p)) byT.set(p[0], p[1]);
  return [...byT.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * Merges a fresh answer into the cached series: the fresh points are authoritative from their first
 * timestamp on; cached points older than that are kept.
 */
export function mergeSeries(cached: readonly ChartPoint[] | null | undefined, fresh: readonly ChartPoint[]): ChartPoint[] {
  const f = normalise(fresh);
  if (f.length === 0) return normalise(cached ?? []);
  const start = f[0]![0];
  return normalise([...(cached ?? []).filter((p) => valid(p) && p[0] < start), ...f]);
}

/**
 * At most `max` points: the time range is cut into `max - 1` equal buckets, each keeping its last
 * point; the first and the last points are always kept.
 */
export function downsample(points: readonly ChartPoint[], max = CHART_MAX_POINTS): ChartPoint[] {
  const s = normalise(points);
  if (s.length <= max || max < 2) return s;
  const first = s[0]!;
  const last = s[s.length - 1]!;
  const width = (last[0] - first[0]) / (max - 1);
  const buckets = new Map<number, ChartPoint>();
  for (const p of s.slice(1, -1)) buckets.set(Math.min(max - 3, Math.floor((p[0] - first[0]) / width)), p);
  return [first, ...[...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p), last];
}

/** The points inside the period ending now. */
export function windowed(points: readonly ChartPoint[], period: ChartPeriod, now: number): ChartPoint[] {
  const from = now - PERIOD_MS[period];
  return points.filter((p) => p[0] >= from);
}

/**
 * What to ask the network for: `null` when the cache is fresh, else the smallest CoinGecko range
 * that covers what is missing (the whole period when the cache does not cover its start).
 */
export function fetchPlan(cached: readonly ChartPoint[] | null, period: ChartPeriod, now: number): ChartDays | null {
  const full = PERIOD_DAYS[period];
  if (!cached || cached.length < 2) return full;
  const first = cached[0]![0];
  const last = cached[cached.length - 1]![0];
  const span = PERIOD_MS[period];
  if (Number.isFinite(span) && first > now - span + span * COVER_SLACK) return full;
  const gap = now - last;
  if (gap < FRESH_MS[period]) return null;
  for (const d of [1, 7, 30, 365] as const) {
    if (d * DAY >= gap) return full === 'max' || d < full ? d : full;
  }
  return full;
}

// --- Storage ----------------------------------------------------------------------------------------

const key = (cur: string, coin: string, period: ChartPeriod) => `cache.chart.${cur}.${coin}.${period}`;
const INDEX = 'cache.chart.index';
const PERIODS: ChartPeriod[] = ['1J', '1S', '1M', '1A', 'Tout'];

export function decodeSeries(raw: unknown): ChartPoint[] | null {
  if (!Array.isArray(raw)) return null;
  const s = normalise(raw as ChartPoint[]);
  return s.length > 0 ? s.slice(-CHART_MAX_POINTS * 2) : null;
}

export function loadChart(currency: string, coinId: string, period: ChartPeriod): ChartPoint[] | null {
  const cur = currency.toLowerCase();
  if (!COIN_RE.test(coinId) || !CUR_RE.test(cur)) return null;
  return decodeSeries(readJson<unknown>(key(cur, coinId, period), null));
}

function remove(k: string): void {
  try {
    window.localStorage.removeItem(`kyro.${k}`);
  } catch {
    /* storage unavailable */
  }
}

export function saveChart(currency: string, coinId: string, period: ChartPeriod, points: readonly ChartPoint[]): void {
  const cur = currency.toLowerCase();
  if (!COIN_RE.test(coinId) || !CUR_RE.test(cur) || points.length === 0) return;
  // Rounded to 7 significant digits: the chart cannot show more, the storage stays small.
  writeJson(
    key(cur, coinId, period),
    downsample(points).map(([t, p]) => [Math.round(t), Number(p.toPrecision(7))]),
  );
  const id = `${cur}.${coinId}`;
  const raw = readJson<unknown>(INDEX, []);
  const list = (Array.isArray(raw) ? raw : []).filter((x): x is string => typeof x === 'string' && x !== id);
  const next = [id, ...list];
  for (const old of next.splice(CHART_MAX_COINS)) for (const p of PERIODS) remove(`cache.chart.${old}.${p}`);
  writeJson(INDEX, next);
}

/**
 * Cached series + the missing recent part from the network, merged and saved; the points of the
 * period. A failed request with something cached keeps the cached chart (no error).
 */
export async function refreshChart(fetchChart: (days: ChartDays) => Promise<ChartPoint[]>, currency: string, coinId: string, period: ChartPeriod, now = Date.now()): Promise<ChartPoint[]> {
  const cached = loadChart(currency, coinId, period);
  const plan = fetchPlan(cached, period, now);
  if (plan === null && cached) return windowed(cached, period, now);
  let fresh: ChartPoint[];
  try {
    fresh = await fetchChart(plan ?? PERIOD_DAYS[period]);
  } catch (e) {
    if (cached && cached.length > 1) return windowed(cached, period, now);
    throw e;
  }
  const merged = mergeSeries(cached, fresh);
  const kept = Number.isFinite(PERIOD_MS[period]) ? windowed(merged, period, now - PERIOD_MS[period] * COVER_SLACK) : merged;
  saveChart(currency, coinId, period, kept);
  return windowed(downsample(merged), period, now);
}
