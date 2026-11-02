// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartPoint } from '@kyro/market';
import { CHART_MAX_COINS, CHART_MAX_POINTS, downsample, fetchPlan, loadChart, mergeSeries, refreshChart, saveChart, windowed } from './chartCache';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const series = (from: number, to: number, step: number, price = 1): ChartPoint[] => {
  const out: ChartPoint[] = [];
  for (let t = from; t < to; t += step) out.push([t, price]);
  out.push([to, price]);
  return out;
};

describe('chart cache', () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } });
  });

  it('merges: fresh points win from their first time, older cached points stay', () => {
    const cached: ChartPoint[] = [
      [1, 10],
      [2, 11],
      [3, 12],
    ];
    expect(
      mergeSeries(cached, [
        [3, 99],
        [4, 13],
      ]),
    ).toEqual([
      [1, 10],
      [2, 11],
      [3, 99],
      [4, 13],
    ]);
    expect(mergeSeries(null, [[5, 1]])).toEqual([[5, 1]]);
    expect(mergeSeries(cached, [])).toEqual(cached);
    expect(mergeSeries([[1, Number.NaN] as ChartPoint], [[2, 1]])).toEqual([[2, 1]]);
  });

  it('downsamples to a bound, keeping the first and last points in order', () => {
    const big = series(NOW - 5 * 365 * DAY, NOW, 3_600_000);
    const s = downsample(big, CHART_MAX_POINTS);
    expect(s.length).toBeLessThanOrEqual(CHART_MAX_POINTS);
    expect(s.length).toBeGreaterThan(CHART_MAX_POINTS - 5);
    expect(s[0]).toEqual(big[0]);
    expect(s[s.length - 1]).toEqual(big[big.length - 1]);
    for (let i = 1; i < s.length; i++) expect(s[i]![0]).toBeGreaterThan(s[i - 1]![0]);
    const small = series(1, 10, 1);
    expect(downsample(small, 400)).toEqual(small);
  });

  it('asks only for the missing recent part', () => {
    const year = series(NOW - 365 * DAY, NOW - 2 * DAY, DAY);
    expect(fetchPlan(null, '1A', NOW)).toBe(365);
    expect(fetchPlan(year, '1A', NOW)).toBe(7);
    expect(fetchPlan(series(NOW - 365 * DAY, NOW - 3_600_000 * 5, DAY), '1A', NOW)).toBe(1);
    expect(fetchPlan(series(NOW - 365 * DAY, NOW - 60_000, DAY), '1A', NOW), 'fresh').toBeNull();
    expect(fetchPlan(series(NOW - 100 * DAY, NOW - 60_000, DAY), '1A', NOW), 'does not cover the year').toBe(365);
    expect(fetchPlan(series(NOW - 3000 * DAY, NOW - 40 * DAY, DAY), 'Tout', NOW)).toBe(365);
    expect(fetchPlan(series(NOW - 7 * DAY, NOW - 2 * DAY, 3_600_000), '1S', NOW)).toBe(7);
  });

  it('keeps a one-year chart on disk and refreshes only its end', async () => {
    const fetch1 = vi.fn(async () => series(NOW - 365 * DAY, NOW - 3 * DAY, DAY, 2));
    const first = await refreshChart(fetch1, 'EUR', 'bitcoin', '1A', NOW);
    expect(fetch1).toHaveBeenCalledWith(365);
    expect(first.length).toBeGreaterThan(300);
    expect(loadChart('EUR', 'bitcoin', '1A')?.length).toBe(first.length);

    const fetch2 = vi.fn(async () => series(NOW - 7 * DAY, NOW, 3_600_000, 3));
    const second = await refreshChart(fetch2, 'EUR', 'bitcoin', '1A', NOW);
    expect(fetch2).toHaveBeenCalledWith(7);
    expect(second[0]![1]).toBe(2);
    expect(second[second.length - 1]).toEqual([NOW, 3]);
    expect(second.length).toBeLessThanOrEqual(CHART_MAX_POINTS);

    const failing = vi.fn(async () => Promise.reject(new Error('offline')));
    const third = await refreshChart(failing, 'EUR', 'bitcoin', '1A', NOW + 3 * 3_600_000);
    expect(third.length).toBeGreaterThan(1);
    await expect(refreshChart(failing, 'EUR', 'ethereum', '1A', NOW)).rejects.toThrow('offline');
  });

  it('windows to the period and keeps only the recent coins', () => {
    expect(windowed(series(NOW - 3 * DAY, NOW, DAY), '1J', NOW)).toEqual([
      [NOW - DAY, 1],
      [NOW, 1],
    ]);
    for (let i = 0; i <= CHART_MAX_COINS; i++) saveChart('USD', `coin-${i}`, '1M', [[NOW, 1]]);
    expect(loadChart('USD', 'coin-0', '1M')).toBeNull();
    expect(loadChart('USD', `coin-${CHART_MAX_COINS}`, '1M')).toEqual([[NOW, 1]]);
    expect(loadChart('USD', '../x', '1M')).toBeNull();
  });
});
