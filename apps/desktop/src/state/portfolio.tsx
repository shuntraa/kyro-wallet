// SPDX-License-Identifier: GPL-3.0-or-later
//
// Balances (all adapters) + market data (CoinGecko top 250), shared by every
// screen of the unlocked app.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { assetsFor } from '@kyro/chains';
import type { MarketCoin, SimplePrice } from '@kyro/market';
import { computeHoldings, type Holding } from '../lib/holdings';
import { useVault, type AccountSource } from './app';
import { useOnTorReady } from './tor';
import { useOnCbfSynced } from './cbf';

export type { Holding } from '../lib/holdings';

interface PortfolioValue {
  /** Balances of the SELECTED account of each chain (what Envoyer / Swap spend from). */
  balances: Map<string, bigint>;
  /** Balances per account: key `${family}:${index}` → asset id → amount. */
  accountBalances: Map<string, Map<string, bigint>>;
  balancesLoading: boolean;
  balancesLoaded: boolean;
  /** chainKey → error message */
  chainErrors: Record<string, string>;
  markets: MarketCoin[] | null;
  marketById: Map<string, MarketCoin>;
  marketError: string | null;
  marketUpdatedAt: number | null;
  price: (coinId: string) => SimplePrice | null;
  /** One row per asset, all accounts added together (totals, allocation, charts). */
  holdings: Holding[];
  /** Like `holdings`, but a chain with several vault accounts gets one row per account. */
  accountHoldings: Holding[];
  total: number;
  change24hFiat: number;
  change24hPct: number | null;
  refresh: () => void;
  updatedAt: number | null;
}

const Ctx = createContext<PortfolioValue | null>(null);

export function usePortfolio(): PortfolioValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePortfolio outside PortfolioProvider');
  return v;
}

const BALANCE_REFRESH_MS = 30_000;
const MARKET_REFRESH_MS = 60_000;

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const { adapters, accounts, market, settings, accountSources } = useVault();
  const network = accounts.network;
  const [accountBalances, setAccountBalances] = useState<Map<string, Map<string, bigint>>>(new Map());
  const [balancesLoading, setBalancesLoading] = useState(true);
  const [balancesLoaded, setBalancesLoaded] = useState(false);
  const [chainErrors, setChainErrors] = useState<Record<string, string>>({});
  const [markets, setMarkets] = useState<MarketCoin[] | null>(null);
  const [extraPrices, setExtraPrices] = useState<Record<string, SimplePrice>>({});
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketUpdatedAt, setMarketUpdatedAt] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const sourcesRef = useRef<AccountSource[]>(accountSources);
  sourcesRef.current = accountSources;
  // Reload when the set of accounts (or their adapters) changes, not on every selection.
  const sourcesKey = accountSources.map((x) => `${x.family}:${x.index}:${x.addresses.join(',')}`).join('|');

  // Tor just became ready (after a bootstrap, a retry or a re-enable): reload now rather than at the next poll.
  useOnTorReady(refresh);
  useOnCbfSynced(refresh);

  // Balances.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      setBalancesLoading(true);
      // Every account of every chain (§2.9): one request per account and chain.
      const jobs = sourcesRef.current.flatMap((src) => src.adapters.map((a) => ({ key: `${src.family}:${src.index}`, a })));
      const results = await Promise.allSettled(jobs.map((j) => j.a.getBalance()));
      if (!alive) return;
      const next = new Map<string, Map<string, bigint>>();
      const errors: Record<string, string> = {};
      results.forEach((r, i) => {
        const j = jobs[i];
        if (!j) return;
        if (r.status === 'fulfilled') {
          const m = next.get(j.key) ?? new Map<string, bigint>();
          r.value.forEach((b) => m.set(b.assetId, b.amount));
          next.set(j.key, m);
        } else errors[j.a.chain.key] ??= r.reason instanceof Error ? r.reason.message : String(r.reason);
      });
      setAccountBalances((prev) => {
        // Keep the last known value of chains that failed this round.
        const merged = new Map<string, Map<string, bigint>>();
        for (const [k, m] of prev) merged.set(k, new Map(m));
        next.forEach((m, k) => {
          const cur = merged.get(k) ?? new Map<string, bigint>();
          m.forEach((v, id) => cur.set(id, v));
          merged.set(k, cur);
        });
        return merged;
      });
      setChainErrors(errors);
      setBalancesLoaded(true);
      setBalancesLoading(false);
      setUpdatedAt(Date.now());
    };
    void load();
    const id = window.setInterval(load, BALANCE_REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [sourcesKey, tick]);

  // Market data.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const list = await market.markets(settings.currency, 250);
        if (!alive) return;
        setMarkets(list);
        setMarketError(null);
        setMarketUpdatedAt(market.lastUpdated ?? Date.now());
        const have = new Set(list.map((c) => c.id));
        const missing = [...new Set(assetsFor(network).map((a) => a.coingeckoId))].filter((id) => !have.has(id));
        if (missing.length) {
          const extra = await market.simplePrice(missing, settings.currency).catch(() => ({}));
          if (alive) setExtraPrices(extra);
        }
      } catch (e) {
        if (alive) setMarketError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const id = window.setInterval(load, MARKET_REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [market, settings.currency, network, tick]);

  const marketById = useMemo(() => new Map((markets ?? []).map((c) => [c.id, c])), [markets]);

  const price = useCallback(
    (coinId: string): SimplePrice | null => {
      const m = marketById.get(coinId);
      if (m) return { price: m.price, change24h: m.change24h };
      return extraPrices[coinId] ?? null;
    },
    [marketById, extraPrices],
  );

  // What Envoyer / Swap spend: the selected account of each chain.
  const balances = useMemo(() => {
    const out = new Map<string, bigint>();
    for (const src of accountSources) {
      // Selected = its adapters are the active ones (vault: the chain's selected account).
      if (!src.adapters.some((a) => adapters.all.includes(a))) continue;
      accountBalances.get(`${src.family}:${src.index}`)?.forEach((v, k) => out.set(k, v));
    }
    return out;
  }, [accountSources, accountBalances, adapters]);

  // Totals: every account of every chain added together, each account once (lib/holdings.ts).
  const { holdings, accountHoldings, total, change24hFiat } = useMemo(
    () =>
      computeHoldings({
        network,
        sources: accountSources.map((x) => ({ family: x.family, index: x.index, name: x.name, chainKeys: x.adapters.map((a) => a.chain.key) })),
        accountBalances,
        chainErrors,
        price,
        marketById,
      }),
    [network, accountBalances, marketById, price, chainErrors, accountSources],
  );

  const value: PortfolioValue = {
    balances,
    accountBalances,
    balancesLoading,
    balancesLoaded,
    chainErrors,
    markets,
    marketById,
    marketError,
    marketUpdatedAt,
    price,
    holdings,
    accountHoldings,
    total,
    change24hFiat,
    change24hPct: total > 0 && total - change24hFiat !== 0 ? (change24hFiat / (total - change24hFiat)) * 100 : null,
    refresh,
    updatedAt,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
