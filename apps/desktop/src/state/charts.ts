// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo } from 'react';
import type { ChartDays, ChartPoint } from '@kyro/market';
import { portfolioSeries } from '../lib/portfolioSeries';
import { useAsync } from '../lib/useAsync';
import { useApp } from './app';
import { usePortfolio } from './portfolio';

export type Period = '1J' | '1S' | '1M' | '1A' | 'Tout';
export const PERIODS: Period[] = ['1J', '1S', '1M', '1A', 'Tout'];
export const PERIOD_DAYS: Record<Period, ChartDays> = { '1J': 1, '1S': 7, '1M': 30, '1A': 365, Tout: 'max' };

export function useCoinChart(coinId: string | null, period: Period) {
  const { market, settings } = useApp();
  return useAsync<ChartPoint[]>(coinId ? () => market.chart(coinId, settings.currency, PERIOD_DAYS[period]) : null, [coinId, period, settings.currency], { intervalMs: 120_000 });
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
          const charts = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await market.chart(id, settings.currency, PERIOD_DAYS[period]).catch(() => [] as ChartPoint[])] as const)));
          return portfolioSeries(held, charts);
        }
      : null,
    [key, period, settings.currency],
    { intervalMs: 120_000 },
  );
}
