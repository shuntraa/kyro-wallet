// SPDX-License-Identifier: GPL-3.0-or-later
// Gains and losses of the active wallet, from the history cache and the price charts kept on this
// device (`lib/gains.ts`). Reading costs no request; the warm-up keeps a year of prices for the coins
// held, through the same chart cache and the same CoinGecko calls as the asset screen.

import { useEffect, useMemo, useRef, useState } from 'react';
import { unitsToNumber } from '@kyro/chains';
import { krakenPair, mergeLongHistory, type ChartPoint } from '@kyro/market';
import { fetchPlan, loadChart, refreshChart } from '../lib/chartCache';
import { HISTORY_CACHE_MAX } from '../lib/balanceCache';
import { computeGains, priceOfDay, totalGains, type CoinGains, type GainEvent, type GainsTotal } from '../lib/gains';
import type { Holding } from '../lib/holdings';
import { peekLong } from '../lib/longHistory';
import { useApp, useVault } from './app';
import { cachedHistory, type HistoryData } from './history';
import { usePortfolio } from './portfolio';

export interface GainsRow {
  holding: Holding;
  gains: CoinGains;
}

export interface GainsView {
  rows: GainsRow[];
  byAsset: ReadonlyMap<string, CoinGains>;
  total: GainsTotal;
}

const REFRESH_MS = 60_000;
/** After the balances, the history and the long charts. */
const WARM_DELAY_MS = 45_000;
const WARM_EVERY_MS = 2 * 3_600_000;
const WARM_GAP_MS = 3_000;
/** Stays below `CHART_MAX_COINS`: the warm-up must not push out the charts it has just kept. */
const WARM_MAX_COINS = 20;

/** A year of prices in the user's currency, extended by the long series like the « All » chart. */
function savedSeries(currency: string, coinId: string, now: number): ChartPoint[] | null {
  const year = loadChart(currency, coinId, '1A');
  if (!year) return null;
  const pair = krakenPair(coinId);
  const long = pair ? peekLong(pair, now) : null;
  return long ? mergeLongHistory(long, year) : year;
}

function eventsByAsset(data: HistoryData | null): Map<string, GainEvent[]> {
  const out = new Map<string, GainEvent[]>();
  for (const e of data?.entries ?? []) {
    if (!e.asset) continue;
    const list = out.get(e.assetId) ?? [];
    list.push({ id: e.id, direction: e.direction, units: unitsToNumber(e.amount, e.asset.decimals), time: e.time, status: e.status, kind: e.kind, suspect: e.suspect });
    out.set(e.assetId, list);
  }
  return out;
}

export function useGains(): GainsView {
  const { settings } = useApp();
  const { accounts, accountSources, isMultiAccount } = useVault();
  const pf = usePortfolio();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);
  const network = accounts.network;
  const currency = settings.currency;
  return useMemo(() => {
    const now = Date.now();
    const data = cachedHistory(network, accountSources, isMultiAccount);
    const events = eventsByAsset(data);
    const perChain = new Map<string, number>();
    for (const e of data?.entries ?? []) perChain.set(e.chainKey, (perChain.get(e.chainKey) ?? 0) + 1);
    const series = new Map<string, ChartPoint[] | null>();
    const seriesOf = (coinId: string) => {
      if (!series.has(coinId)) series.set(coinId, savedSeries(currency, coinId, now));
      return series.get(coinId) ?? null;
    };
    const rows = pf.holdings
      .filter((h) => h.amount > 0n)
      .map((holding): GainsRow => {
        const { asset, units, price } = holding;
        const points = seriesOf(asset.coingeckoId);
        const historyComplete = !!data?.known.includes(asset.chainKey) && (perChain.get(asset.chainKey) ?? 0) < HISTORY_CACHE_MAX && !(asset.family === 'btc' && data.btcCapped) && !(asset.family === 'dot' && data.dotHistory !== 'ok');
        const gains = computeGains({ events: events.get(asset.id) ?? [], balance: units, price, priceAt: (t) => (points ? priceOfDay(points, t, now) : null), historyComplete });
        return { holding, gains };
      });
    return {
      rows,
      byAsset: new Map(rows.map((r) => [r.holding.asset.id, r.gains])),
      total: totalGains(rows.map((r) => ({ gains: r.gains, value: r.holding.value, price: r.holding.price }))),
    };
  }, [pf.holdings, network, accountSources, isMultiAccount, currency, tick]);
}

/** Keeps a year of prices for the coins held, largest first (mounted once in the unlocked shell). */
export function useGainsWarmup(): void {
  const { market, settings } = useApp();
  const pf = usePortfolio();
  const currency = settings.currency;
  const ids = [...new Set([...pf.holdings].filter((h) => h.amount > 0n).sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).map((h) => h.asset.coingeckoId))].slice(0, WARM_MAX_COINS).join(' ');
  const held = useRef(ids);
  held.current = ids;
  useEffect(() => {
    if (!ids) return;
    let alive = true;
    let busy = false;
    const run = async () => {
      if (busy) return;
      busy = true;
      for (const id of held.current.split(' ')) {
        if (!alive) break;
        if (fetchPlan(loadChart(currency, id, '1A'), '1A', Date.now()) === null) continue;
        await refreshChart((days) => market.chart(id, currency, days), currency, id, '1A').catch(() => undefined);
        await new Promise((r) => window.setTimeout(r, WARM_GAP_MS));
      }
      busy = false;
    };
    const first = window.setTimeout(() => void run(), WARM_DELAY_MS);
    const every = window.setInterval(() => void run(), WARM_EVERY_MS);
    return () => {
      alive = false;
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [ids, currency, market]);
}
