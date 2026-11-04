// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { krakenPair, mergeLongHistory, type ChartDays, type ChartPoint } from '@kyro/market';
import { loadChart, refreshChart, windowed } from '../lib/chartCache';
import { hasLongHistory, longUsd, peekLong, warmLongHistory } from '../lib/longHistory';
import { portfolioSeries } from '../lib/portfolioSeries';
import { useAsync, type AsyncState } from '../lib/useAsync';
import { useApp } from './app';
import { usePortfolio } from './portfolio';

export type Period = '1J' | '1S' | '1M' | '1A' | 'Tout';
export const PERIODS: Period[] = ['1J', '1S', '1M', '1A', 'Tout'];
/** The periods offered for a coin: « All » only when a long source exists (else it equals 1Y). */
export function coinPeriods(coinId: string): Period[] {
  return hasLongHistory(coinId) ? PERIODS : PERIODS.filter((p) => p !== 'Tout');
}
/** What CoinGecko is asked for. Never `max`: its public API refuses more than 365 days (HTTP 401). */
export const PERIOD_DAYS: Record<Period, ChartDays> = { '1J': 1, '1S': 7, '1M': 30, '1A': 365, Tout: 365 };

/** A few seconds after unlock (balances first); fresh coins then cost nothing. */
const LONG_WARM_DELAY_MS = 20_000;
const LONG_WARM_EVERY_MS = 30 * 60_000;

/**
 * An asset's price series: the one kept on this device shows at once (`chartCache.ts`), then only
 * the missing recent part is fetched and merged in.
 */
function useCoinSeries(coinId: string | null, period: Period): AsyncState<ChartPoint[]> {
  const { market, settings } = useApp();
  const cur = settings.currency;
  const id = coinId ? `${cur}|${coinId}|${period}` : '';
  const cached = useMemo(() => (coinId ? loadChart(cur, coinId, period) : null), [id]);
  const res = useAsync<{ id: string; points: ChartPoint[] }>(
    coinId
      ? async () => ({ id, points: await refreshChart((days: ChartDays) => market.chart(coinId, cur, days), cur, coinId, period) })
      : null,
    [coinId, period, cur],
    { intervalMs: 120_000 },
  );
  const fresh = res.data?.id === id ? res.data.points : undefined;
  // The previous period's points hold the chart while the new ones load, never after a failure:
  // they would be shown under the wrong period.
  const data = fresh ?? (cached && cached.length > 1 ? windowed(cached, period, Date.now()) : res.error ? undefined : res.data?.points);
  return { ...res, data, error: data && data.length > 1 ? null : res.error };
}

/**
 * A coin's chart. « All » is its 1Y series extended to the left with the long one: 1Y shows at once
 * and neither waits for the other. `partial`: the long series is not there yet (the first point is
 * not the coin's start).
 */
export function useCoinChart(coinId: string | null, period: Period): AsyncState<ChartPoint[]> & { partial: boolean } {
  const base = useCoinSeries(coinId, period === 'Tout' ? '1A' : period);
  const pair = period === 'Tout' && coinId ? krakenPair(coinId) : null;
  const saved = useMemo(() => (pair ? peekLong(pair) : null), [pair]);
  const res = useAsync<{ pair: string; points: ChartPoint[] }>(pair ? async () => ({ pair, points: await longUsd(pair) }) : null, [pair], pair ? { intervalMs: 120_000 } : {});
  const fresh = res.data?.pair === pair && res.data?.points.length ? res.data.points : undefined;
  const long = fresh ?? saved;
  const data = useMemo(() => (pair && long && base.data ? mergeLongHistory(long, base.data) : base.data), [pair, long, base.data]);
  const { reload: reloadBase } = base;
  const { reload: reloadLong } = res;
  const reload = useCallback(() => {
    reloadBase();
    reloadLong();
  }, [reloadBase, reloadLong]);
  return { ...base, data, reload, partial: pair !== null && !long };
}

/** Keeps the long history of the held coins on this device (mounted once in the unlocked shell). */
export function useLongHistoryWarmup(): void {
  const pf = usePortfolio();
  const ids = [...new Set(pf.holdings.filter((h) => h.units > 0).map((h) => h.asset.coingeckoId))].sort().join(' ');
  const held = useRef(ids);
  held.current = ids;
  useEffect(() => {
    if (!ids) return;
    let alive = true;
    let busy = false;
    const run = () => {
      if (busy) return;
      busy = true;
      void warmLongHistory(held.current.split(' '), () => alive).finally(() => {
        busy = false;
      });
    };
    const first = window.setTimeout(run, LONG_WARM_DELAY_MS);
    const every = window.setInterval(run, LONG_WARM_EVERY_MS);
    return () => {
      alive = false;
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [ids]);
}

/** Value of the current holdings over the period (constant composition). */
export function usePortfolioChart(period: Period) {
  const { market, settings } = useApp();
  const pf = usePortfolio();
  const held = useMemo(
    () =>
      pf.holdings
        .filter((h) => h.value && h.value > 0)
        .reduce<Array<{ coinId: string; units: number; currentPrice: number }>>((acc, h) => {
          const ex = acc.find((x) => x.coinId === h.asset.coingeckoId);
          if (ex) ex.units += h.units;
          else acc.push({ coinId: h.asset.coingeckoId, units: h.units, currentPrice: h.price ?? 0 });
          return acc;
        }, []),
    [pf.holdings],
  );
  const key = held.map((h) => `${h.coinId}:${h.units.toFixed(8)}`).join('|');
  return useAsync(
    held.length
      ? async () => {
          const ids = [...new Set(held.map((h) => h.coinId))];
          const series = async (id: string) => {
            const recent = await market.chart(id, settings.currency, PERIOD_DAYS[period]).catch(() => [] as ChartPoint[]);
            const pair = period === 'Tout' ? krakenPair(id) : null;
            return pair ? mergeLongHistory(await longUsd(pair).catch(() => [] as ChartPoint[]), recent) : recent;
          };
          const charts = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await series(id)] as const)));
          return portfolioSeries(held, charts);
        }
      : null,
    [key, period, settings.currency],
    { intervalMs: 120_000 },
  );
}
