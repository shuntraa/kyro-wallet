// SPDX-License-Identifier: GPL-3.0-or-later
// Long price history for the « All » chart: Kraken's public weekly candles (no key, `api.kraken.com`
// over `net_fetch`), back to the pair's listing (~2013 for BTC). The public CoinGecko API stops at
// 365 days, so « All » is Kraken's past joined to CoinGecko's recent series.

import { fetchJson, netFetch, type NetFetch } from '@kyro/shared';
import type { ChartPoint } from './coingecko';

/** CoinGecko id → Kraken USD pair, for the coins Kraken lists with a long history. */
export const KRAKEN_PAIRS: Readonly<Record<string, string>> = {
  bitcoin: 'XBTUSD',
  ethereum: 'ETHUSD',
  litecoin: 'LTCUSD',
  dogecoin: 'XDGUSD',
  ripple: 'XRPUSD',
  monero: 'XMRUSD',
  zcash: 'ZECUSD',
  'bitcoin-cash': 'BCHUSD',
  dash: 'DASHUSD',
  stellar: 'XLMUSD',
  cardano: 'ADAUSD',
  polkadot: 'DOTUSD',
  solana: 'SOLUSD',
  tron: 'TRXUSD',
  algorand: 'ALGOUSD',
  cosmos: 'ATOMUSD',
  'avalanche-2': 'AVAXUSD',
  near: 'NEARUSD',
  chainlink: 'LINKUSD',
  uniswap: 'UNIUSD',
  tezos: 'XTZUSD',
  'ethereum-classic': 'ETCUSD',
  tether: 'USDTZUSD',
  'usd-coin': 'USDCUSD',
};

/** The Kraken pair of a coin, `null` when it has no long source (its « All » button is hidden). */
export function krakenPair(coinId: string): string | null {
  return Object.hasOwn(KRAKEN_PAIRS, coinId) ? (KRAKEN_PAIRS[coinId] ?? null) : null;
}

/**
 * `/0/public/OHLC` answer → `[ms, open]` points (sorted, invalid rows dropped). A candle's time is
 * its start, so the open is the price at that time (the close is a week later).
 */
export function parseKrakenOhlc(raw: unknown): ChartPoint[] {
  const r = raw as { error?: unknown; result?: Record<string, unknown> } | null;
  if (!r || typeof r !== 'object' || (Array.isArray(r.error) && r.error.length > 0) || !r.result) return [];
  const rows = Object.entries(r.result).find(([k, v]) => k !== 'last' && Array.isArray(v))?.[1] as unknown[] | undefined;
  const out: ChartPoint[] = [];
  for (const row of rows ?? []) {
    if (!Array.isArray(row)) continue;
    const t = Number(row[0]) * 1000;
    const open = Number(row[1]);
    if (Number.isFinite(t) && t > 0 && Number.isFinite(open) && open > 0) out.push([t, open]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Weekly prices in USD (up to 720 weeks, Kraken's limit per answer). */
export async function krakenWeekly(pair: string, fetcher: NetFetch = netFetch): Promise<ChartPoint[]> {
  if (!/^[A-Z]{5,10}$/.test(pair)) throw new Error('bad pair');
  return parseKrakenOhlc(await fetchJson<unknown>(fetcher, `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=10080`));
}

/**
 * Joins the long USD series (sorted) to the recent one (display currency): the long points older
 * than the recent series are kept, scaled by the ratio at the junction (the currency conversion,
 * and no jump between the two sources). The long price at the junction is read between the two
 * weekly points around it: taken from the point before, a week's move would scale all the history.
 */
export function mergeLongHistory(longUsd: readonly ChartPoint[], recent: readonly ChartPoint[]): ChartPoint[] {
  const first = recent[0];
  if (!first) return [...recent];
  const before = longUsd.filter((p) => p[0] < first[0]);
  const anchor = before[before.length - 1];
  if (!anchor || anchor[1] <= 0) return [...recent];
  const next = longUsd[before.length];
  const junction = next ? anchor[1] + ((next[1] - anchor[1]) * (first[0] - anchor[0])) / (next[0] - anchor[0]) : anchor[1];
  const k = first[1] / junction;
  return [...before.map(([t, p]): ChartPoint => [t, p * k]), ...recent];
}
