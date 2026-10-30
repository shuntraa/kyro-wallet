// SPDX-License-Identifier: GPL-3.0-or-later
//
// Balances (all adapters) + market data (CoinGecko top 200), shared by every
// screen of the unlocked app.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { assetsFor, findChain, unitsToNumber, type AssetDef } from '@kyro/chains';
import type { MarketCoin, SimplePrice } from '@kyro/market';
import { useVault } from './app';
import { useOnTorReady } from './tor';
import { useOnCbfSynced } from './cbf';

export interface Holding {
  asset: AssetDef;
  amount: bigint;
  units: number;
  price: number | null;
  change24h: number | null;
  change7d: number | null;
  value: number | null;
  spark: number[];
  /** 0..1 of the portfolio value. */
  share: number;
  /** Balance could not be loaded (RPC error). */
  failed: boolean;
}

interface PortfolioValue {
  balances: Map<string, bigint>;
  balancesLoading: boolean;
  balancesLoaded: boolean;
  /** chainKey → error message */
  chainErrors: Record<string, string>;
  markets: MarketCoin[] | null;
  marketById: Map<string, MarketCoin>;
  marketError: string | null;
  marketUpdatedAt: number | null;
  price: (coinId: string) => SimplePrice | null;
  holdings: Holding[];
  total: number;
  change24hFiat: number;
  change24hPct: number | null;
  refresh: () => void;
  updatedAt: number | null;
}

const Ctx = createContext<PortfolioValue | null>(null);

export function usePortfolio(): PortfolioValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePortfolio hors PortfolioProvider');
  return v;
}

const BALANCE_REFRESH_MS = 30_000;
const MARKET_REFRESH_MS = 60_000;

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const { adapters, accounts, market, settings } = useVault();
  const network = accounts.network;
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());
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
  const adaptersRef = useRef(adapters);
  adaptersRef.current = adapters;

  // Tor just became ready (after a bootstrap, a retry or a re-enable): reload now rather than at the next poll.
  useOnTorReady(refresh);
  useOnCbfSynced(refresh);

  // Balances.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      setBalancesLoading(true);
      const results = await Promise.allSettled(adaptersRef.current.all.map((a) => a.getBalance()));
      if (!alive) return;
      const next = new Map<string, bigint>();
      const errors: Record<string, string> = {};
      results.forEach((r, i) => {
        const a = adaptersRef.current.all[i];
        if (!a) return;
        if (r.status === 'fulfilled') r.value.forEach((b) => next.set(b.assetId, b.amount));
        else errors[a.chain.key] = r.reason instanceof Error ? r.reason.message : String(r.reason);
      });
      setBalances((prev) => {
        // Keep the last known value of chains that failed this round.
        const merged = new Map(prev);
        next.forEach((v, k) => merged.set(k, v));
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
  }, [adapters, tick]);

  // Market data.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const list = await market.markets(settings.currency, 200);
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

  const { holdings, total, change24hFiat } = useMemo(() => {
    const rows: Holding[] = [];
    for (const asset of assetsFor(network)) {
      const amount = balances.get(asset.id) ?? 0n;
      const chain = findChain(network, asset.chainKey);
      const always = asset.kind === 'native' && chain?.phase === 1;
      if (!always && amount === 0n) continue;
      const m = marketById.get(asset.coingeckoId);
      const p = price(asset.coingeckoId);
      const units = unitsToNumber(amount, asset.decimals);
      rows.push({
        asset,
        amount,
        units,
        price: p?.price ?? null,
        change24h: p?.change24h ?? null,
        change7d: m?.change7d ?? null,
        value: p ? units * p.price : null,
        spark: m?.sparkline7d ?? [],
        share: 0,
        failed: chainErrors[asset.chainKey] !== undefined && !balances.has(asset.id),
      });
    }
    const sum = rows.reduce((s, r) => s + (r.value ?? 0), 0);
    let delta = 0;
    for (const r of rows) {
      r.share = sum > 0 && r.value ? r.value / sum : 0;
      if (r.value && r.change24h !== null) delta += r.value - r.value / (1 + r.change24h / 100);
    }
    rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || Number(b.amount - a.amount));
    return { holdings: rows, total: sum, change24hFiat: delta };
  }, [network, balances, marketById, price, chainErrors]);

  const value: PortfolioValue = {
    balances,
    balancesLoading,
    balancesLoaded,
    chainErrors,
    markets,
    marketById,
    marketError,
    marketUpdatedAt,
    price,
    holdings,
    total,
    change24hFiat,
    change24hPct: total > 0 && total - change24hFiat !== 0 ? (change24hFiat / (total - change24hFiat)) * 100 : null,
    refresh,
    updatedAt,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
