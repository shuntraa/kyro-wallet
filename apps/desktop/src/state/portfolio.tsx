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
import { recordNetErrors } from '../lib/netErrors';
import { Dedupe, settleWithin } from '../lib/dedupe';

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
/** A balance round ends after this even if a chain is still busy (it applies its answer later). */
const ROUND_MS = 20_000;
/** In-flight balance requests per account and chain (a poll never doubles a slow one). */
const balanceRequests = new Dedupe(0);

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const { adapters, accounts, market, settings, accountSources } = useVault();
  const network = accounts.network;
  // Last known balances in the very first render (no empty frame before the cache effect below).
  const [accountBalances, setAccountBalances] = useState<Map<string, Map<string, bigint>>>(() => loadBalances(network, fingerprint(accountSources.map((x) => `${x.family}:${x.index}:${x.addresses.join(',')}`).join('|'))) ?? new Map());
  const [balancesLoading, setBalancesLoading] = useState(true);
  const [balancesLoaded, setBalancesLoaded] = useState(false);
  const [chainErrors, setChainErrors] = useState<Record<string, string>>({});
  // Last known market list (any age) until the network answers: the markets list never starts empty.
  const [markets, setMarkets] = useState<MarketCoin[] | null>(() => market.peekMarkets(settings.currency, 250));
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
      const errors: Record<string, string> = {};
      // Each chain is shown as soon as it answers (the fastest within a second or two), not when
      // the slowest one does; a request still running is joined, never sent twice.
      const apply = (key: string, list: Array<{ assetId: string; amount: bigint }>) =>
        setAccountBalances((prev) => {
          const merged = new Map(prev);
          const cur = new Map(prev.get(key) ?? []);
          list.forEach((b) => cur.set(b.assetId, b.amount));
          merged.set(key, cur);
          // Persist this account (amounts only), for the next launch.
          const { network: net, fp: id } = cacheRef.current;
          const stored = loadBalances(net, id) ?? new Map<string, Map<string, bigint>>();
          stored.set(key, cur);
          saveBalances(net, id, stored);
          return merged;
        });
      await settleWithin(
        jobs.map((j) =>
          balanceRequests.run(`${j.key}|${j.a.chain.key}|${sourcesKey}`, () => j.a.getBalance()).then(
            (list) => {
              if (alive) apply(j.key, list);
            },
            (e: unknown) => {
              errors[j.a.chain.key] ??= e instanceof Error ? e.message : String(e);
            },
          ),
        ),
        ROUND_MS,
      );
      if (!alive) return;
      const settled = settleErrors(errors, failingSince.current, Date.now());
      failingSince.current = settled.since;
      setChainErrors(settled.visible);
      recordNetErrors('balances', settled.visible);
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

  // Another currency: its last known list at once, not the previous currency's prices.
  useEffect(() => setMarkets(market.peekMarkets(settings.currency, 250)), [market, settings.currency]);

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
