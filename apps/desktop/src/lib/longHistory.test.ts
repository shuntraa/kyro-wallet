import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartPoint } from '@kyro/market';
import { coinPeriods } from '../state/charts';
import { loadChart, saveChart } from './chartCache';
import { hasLongHistory, longUsd, peekLong, warmLongHistory } from './longHistory';
import { readJson, writeJson } from './storage';

const weekly = vi.hoisted(() => vi.fn<(pair: string) => Promise<Array<[number, number]>>>());
vi.mock('@kyro/market', async (actual) => ({ ...(await actual<typeof import('@kyro/market')>()), krakenWeekly: weekly }));

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const LONG: ChartPoint[] = [
  [NOW - 4000 * DAY, 100],
  [NOW - 7 * DAY, 90_000],
];
const SHORT: ChartPoint[] = [
  [NOW - 360 * DAY, 100_000],
  [NOW - 7 * DAY, 90_000],
];

describe('All period', () => {
  it('is offered only for coins with a long history source', () => {
    expect(hasLongHistory('bitcoin')).toBe(true);
    expect(coinPeriods('bitcoin')).toContain('Tout');
    expect(hasLongHistory('kaspa')).toBe(false);
    expect(coinPeriods('kaspa')).not.toContain('Tout');
    expect(coinPeriods('kaspa')).toContain('1A');
  });
});

describe('long history cache', () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } });
    weekly.mockReset();
  });

  it('serves a saved long series for a week, without the network', async () => {
    writeJson('cache.kraken.XBTUSD', { t: NOW - 6 * DAY, p: LONG });
    expect(await longUsd('XBTUSD', NOW)).toEqual(LONG);
    expect(weekly).not.toHaveBeenCalled();
  });

  it('refreshes after a week, and keeps the saved series when the network fails', async () => {
    writeJson('cache.kraken.XBTUSD', { t: NOW - 8 * DAY, p: LONG });
    weekly.mockRejectedValueOnce(new Error('tor'));
    expect(await longUsd('XBTUSD', NOW)).toEqual(LONG);
    const next: ChartPoint[] = [[NOW - 5000 * DAY, 5], ...LONG];
    weekly.mockResolvedValueOnce(next);
    expect(await longUsd('XBTUSD', NOW)).toEqual(next);
    expect(peekLong('XBTUSD', NOW)).toEqual(next);
  });

  it('keeps saved weeks older than the answer (Kraken stops at 720 weeks)', async () => {
    writeJson('cache.kraken.XBTUSD', { t: NOW - 8 * DAY, p: LONG });
    const answer: ChartPoint[] = [
      [NOW - 3000 * DAY, 1000],
      [NOW - DAY, 95_000],
    ];
    weekly.mockResolvedValueOnce(answer);
    expect(await longUsd('XBTUSD', NOW)).toEqual([LONG[0], ...answer]);
  });

  it('drops a saved series of about a year and fetches the real one', async () => {
    writeJson('cache.kraken.XBTUSD', { t: NOW - DAY, p: SHORT });
    expect(peekLong('XBTUSD', NOW)).toBeNull();
    expect(readJson('cache.kraken.XBTUSD', null)).toBeNull();
    writeJson('cache.kraken.XBTUSD', { t: NOW - DAY, p: SHORT });
    weekly.mockResolvedValueOnce(LONG);
    expect(await longUsd('XBTUSD', NOW)).toEqual(LONG);
    expect(weekly).toHaveBeenCalledOnce();
  });

  it('never saves a short answer as the long history', async () => {
    weekly.mockResolvedValueOnce(SHORT);
    await longUsd('XBTUSD', NOW);
    expect(peekLong('XBTUSD', NOW)).toBeNull();
  });

  it('asks once for two callers at the same time', async () => {
    weekly.mockResolvedValue(LONG);
    await Promise.all([longUsd('XBTUSD', NOW), longUsd('XBTUSD', NOW)]);
    expect(weekly).toHaveBeenCalledOnce();
  });

  it('warm-up: fetches held coins with a pair, one at a time, and forgets the old « All » series', async () => {
    saveChart('usd', 'bitcoin', 'Tout', SHORT);
    saveChart('usd', 'bitcoin', '1A', SHORT);
    writeJson('cache.kraken.ETHUSD', { t: NOW - DAY, p: LONG });
    let running = 0;
    weekly.mockImplementation(async () => {
      expect(++running).toBe(1);
      await Promise.resolve();
      running -= 1;
      return LONG;
    });
    await warmLongHistory(['bitcoin', 'ethereum', 'kaspa', 'solana'], () => true, 0, () => NOW);
    expect(weekly.mock.calls.map((c) => c[0])).toEqual(['XBTUSD', 'SOLUSD']);
    expect(loadChart('usd', 'bitcoin', 'Tout')).toBeNull();
    expect(loadChart('usd', 'bitcoin', '1A')).not.toBeNull();
  });

  it('warm-up stops with the session', async () => {
    await warmLongHistory(['bitcoin'], () => false, 0, () => NOW);
    expect(weekly).not.toHaveBeenCalled();
  });
});
