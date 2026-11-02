// SPDX-License-Identifier: GPL-3.0-or-later
// Balances (all adapters) + market data (CoinGecko top 250), shared by every screen of the unlocked
// app.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { assetsFor } from '@kyro/chains';
import type { MarketCoin, SimplePrice } from '@kyro/market';
import { computeHoldings, type Holding } from '../lib/holdings';
import { useVault, type AccountSource } from './app';
import { useOnTorReady } from './tor';
import { useOnCbfSynced } from './cbf';
import { BALANCE_REFRESH_MS, balanceRetryDelay } from '../lib/retry';
import { fingerprint, loadBalances, loadPrices, saveBalances, savePrices, settleErrors } from '../lib/balanceCache';

export type { Holding } from '../lib/holdings';

interface PortfolioValue {
  balances: Map<string, bigint>;
  /** Balances per account: key `${family}:${index}` → asset id → amount. */
  accountBalances: Map<string, Map<string, bigint>>;
  balancesLoading: boolean;
  balancesLoaded: boolean;
  /**
   * chainKey → error message, only for chains that kept failing after the automatic retries
   * (`ERROR_GRACE_MS`): the first load over Tor stays silent.
   */
  chainErrors: Record<string, string>;
  markets: MarketCoin[] | null;
  marketById: Map<string, MarketCoin>;
  marketError: string | null;
  marketUpdatedAt: number | null;
  price: (coinId: string) => SimplePrice | null;
  holdings: Holding[];
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
  const sourcesKey = accountSources.map((x) => `${x.family}:${x.index}:${x.addresses.join(',')}`).join('|');
  const fp = useMemo(() => fingerprint(sourcesKey), [sourcesKey]);
  const failingSince = useRef<Record<string, number>>({});
  const cacheRef = useRef({ network, fp });
  cacheRef.current = { network, fp };
  const [cachedPrices, setCachedPrices] = useState(() => ({ ...loadPrices(`${settings.currency}.extra`), ...loadPrices(settings.currency) }));
  useEffect(() => setCachedPrices({ ...loadPrices(`${settings.currency}.extra`), ...loadPrices(settings.currency) }), [settings.currency]);

  // Last known balances of this wallet: shown at once, replaced in place as fresh ones arrive.
  useEffect(() => {
    if (!sourcesKey) return;
    const cached = loadBalances(network, fp);
    if (!cached) return;
    setAccountBalances((prev) => {
      const merged = new Map(cached);
      prev.forEach((m, k) => merged.set(k, new Map([...(cached.get(k) ?? new Map<string, bigint>()), ...m])));
      return merged;
    });
  }, [network, fp, sourcesKey]);

  // Tor just became ready (after a bootstrap, a retry or a re-enable): reload now rather than at the next poll.
  useOnTorReady(refresh);
  useOnCbfSynced(refresh);

  useEffect(() => {
    let alive = true;
    let failures = 0;
    let retry: number | undefined;
    const load = async () => {
      window.clearTimeout(retry);
      setBalancesLoading(true);
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
        const merged = new Map<string, Map<string, bigint>>();
        for (const [k, m] of prev) merged.set(k, new Map(m));
        next.forEach((m, k) => {
          const cur = merged.get(k) ?? new Map<string, bigint>();
          m.forEach((v, id) => cur.set(id, v));
          merged.set(k, cur);
        });
        // Persist only the accounts of this round (amounts only), for the next launch.
        const { network: net, fp: id } = cacheRef.current;
        const stored = loadBalances(net, id) ?? new Map<string, Map<string, bigint>>();
        next.forEach((_, k) => stored.set(k, merged.get(k) ?? new Map<string, bigint>()));
        saveBalances(net, id, stored);
        return merged;
      });
      const settled = settleErrors(errors, failingSince.current, Date.now());
      failingSince.current = settled.since;
      setChainErrors(settled.visible);
      setBalancesLoaded(true);
      setBalancesLoading(false);
      setUpdatedAt(Date.now());
      // A chain failed (default server hiccup, a Tor circuit that timed out): try again soon with backoff, not only at the next poll.
      failures = Object.keys(errors).length > 0 ? failures + 1 : 0;
      const delay = balanceRetryDelay(failures);
      if (delay !== null) retry = window.setTimeout(load, delay);
    };
    void load();
    const id = window.setInterval(load, BALANCE_REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.clearTimeout(retry);
    };
  }, [sourcesKey, tick]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const list = await market.markets(settings.currency, 250);
        if (!alive) return;
        setMarkets(list);
        savePrices(settings.currency, Object.fromEntries(list.map((c) => [c.id, { price: c.price, change24h: c.change24h }])));
        setMarketError(null);
        setMarketUpdatedAt(market.lastUpdated ?? Date.now());
        const have = new Set(list.map((c) => c.id));
        const missing = [...new Set(assetsFor(network).map((a) => a.coingeckoId))].filter((id) => !have.has(id));
        if (missing.length) {
          const extra = await market.simplePrice(missing, settings.currency).catch(() => ({}));
          if (alive) {
            setExtraPrices(extra);
            savePrices(`${settings.currency}.extra`, extra);
          }
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
      return extraPrices[coinId] ?? cachedPrices[coinId] ?? null;
    },
    [marketById, extraPrices, cachedPrices],
  );

  const balances = useMemo(() => {
    const out = new Map<string, bigint>();
    for (const src of accountSources) {
      if (!src.adapters.some((a) => adapters.all.includes(a))) continue;
      accountBalances.get(`${src.family}:${src.index}`)?.forEach((v, k) => out.set(k, v));
    }
    return out;
  }, [accountSources, accountBalances, adapters]);

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
