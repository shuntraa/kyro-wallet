// SPDX-License-Identifier: GPL-3.0-or-later
//
// Portfolio rows and totals from per-account balances (docs/IPC.md §2.9): one row per asset with
// every account added together (totals, allocation), and one row per account for chains with
// several accounts. Pure, so the totals are tested with many accounts.

import { assetsFor, findChain, unitsToNumber, type AssetDef } from '@kyro/chains';
import type { AccountChain, Network } from '@kyro/shared';
import type { MarketCoin, SimplePrice } from '@kyro/market';

export interface Holding {
  /** Unique row key: the asset id, plus `@index` for a row of one account among several. */
  key: string;
  asset: AssetDef;
  /** Set on per-account rows of a chain with several vault accounts (§2.9). */
  account?: { family: AccountChain; index: number; name: string };
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

/** One account of the active wallet on one family, and the chains its adapters cover. */
export interface HoldingSource {
  family: AccountChain;
  index: number;
  name: string;
  chainKeys: string[];
}

export interface HoldingsInput {
  network: Network;
  sources: HoldingSource[];
  /** `${family}:${index}` → asset id → amount (keys of removed accounts are ignored). */
  accountBalances: ReadonlyMap<string, ReadonlyMap<string, bigint>>;
  /** chainKey → error message of the last round. */
  chainErrors: Record<string, string>;
  price: (coinId: string) => SimplePrice | null;
  marketById: ReadonlyMap<string, MarketCoin>;
}

export interface HoldingsResult {
  holdings: Holding[];
  accountHoldings: Holding[];
  total: number;
  change24hFiat: number;
}

export function computeHoldings({ network, sources: allSources, accountBalances, chainErrors, price, marketById }: HoldingsInput): HoldingsResult {
  const perAccount: Holding[] = [];
  const aggregate: Holding[] = [];
  const row = (asset: AssetDef, amount: bigint, failed: boolean, key: string, account?: Holding['account']): Holding => {
    const m = marketById.get(asset.coingeckoId);
    const p = price(asset.coingeckoId);
    const units = unitsToNumber(amount, asset.decimals);
    return {
      key,
      asset,
      ...(account ? { account } : {}),
      amount,
      units,
      price: p?.price ?? null,
      change24h: p?.change24h ?? null,
      change7d: m?.change7d ?? null,
      value: p ? units * p.price : null,
      spark: m?.sparkline7d ?? [],
      share: 0,
      failed,
    };
  };
  for (const asset of assetsFor(network)) {
    const family = asset.family as AccountChain;
    // Only the chains of the active wallet (a hardware wallet may hold only some of them),
    // and every account of the chain that has this asset's chain (each account counted once).
    const sources: HoldingSource[] = [];
    for (const x of allSources) if (x.family === family && x.chainKeys.includes(asset.chainKey) && !sources.some((s) => s.index === x.index)) sources.push(x);
    if (sources.length === 0) continue;
    const chain = findChain(network, asset.chainKey);
    // Phase 1 natives, Litecoin / Dogecoin / Bitcoin Cash / Dash (« configure ton serveur »), TRX, XRP, ADA, XLM and NEAR always show.
    const always = asset.kind === 'native' && (chain?.phase === 1 || asset.family === 'ltc' || asset.family === 'doge' || asset.family === 'bch' || asset.family === 'dash' || asset.family === 'tron' || asset.family === 'xrp' || asset.family === 'ada' || asset.family === 'xlm' || asset.family === 'near');
    const errored = chainErrors[asset.chainKey] !== undefined;
    let sum = 0n;
    let known = false;
    const multi = sources.length > 1;
    for (const src of sources) {
      const m = accountBalances.get(`${src.family}:${src.index}`);
      const amount = m?.get(asset.id) ?? 0n;
      const has = m?.has(asset.id) ?? false;
      sum += amount;
      known ||= has;
      if (multi && (always || amount > 0n)) perAccount.push(row(asset, amount, errored && !has, `${asset.id}@${src.index}`, { family, index: src.index, name: src.name }));
    }
    if (!always && sum === 0n) continue;
    const agg = row(asset, sum, errored && !known, asset.id);
    aggregate.push(agg);
    if (!multi) perAccount.push(agg);
  }
  const total = aggregate.reduce((s, r) => s + (r.value ?? 0), 0);
  let delta = 0;
  for (const r of aggregate) {
    r.share = total > 0 && r.value ? r.value / total : 0;
    if (r.value && r.change24h !== null) delta += r.value - r.value / (1 + r.change24h / 100);
  }
  for (const r of perAccount) if (r.account) r.share = total > 0 && r.value ? r.value / total : 0;
  const order = (a: Holding, b: Holding) => (b.value ?? -1) - (a.value ?? -1) || Number(b.amount - a.amount);
  aggregate.sort(order);
  perAccount.sort(order);
  return { holdings: aggregate, accountHoldings: perAccount, total, change24hFiat: delta };
}
