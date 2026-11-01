import { describe, expect, it } from 'vitest';
import { assetsFor, type AssetDef } from '@kyro/chains';
import type { AccountChain } from '@kyro/shared';
import { computeHoldings, type HoldingSource } from './holdings';

const assets = assetsFor('mainnet');
const native = (family: AccountChain): AssetDef => {
  const a = assets.find((x) => x.family === family && x.kind === 'native');
  if (!a) throw new Error(family);
  return a;
};
const btc = native('btc');
const sol = native('sol');
const prices: Record<string, number> = { [btc.coingeckoId]: 50_000, [sol.coingeckoId]: 100 };
const price = (id: string) => (prices[id] !== undefined ? { price: prices[id], change24h: 10 } : null);

function run(sources: HoldingSource[], balances: Array<[string, string, bigint]>, chainErrors: Record<string, string> = {}) {
  const accountBalances = new Map<string, Map<string, bigint>>();
  for (const [key, id, v] of balances) accountBalances.set(key, (accountBalances.get(key) ?? new Map()).set(id, v));
  return computeHoldings({ network: 'mainnet', sources, accountBalances, chainErrors, price, marketById: new Map() });
}

const btcAccounts = (n: number): HoldingSource[] => Array.from({ length: n }, (_, i) => ({ family: 'btc', index: i, name: `Bitcoin ${i + 1}`, chainKeys: [btc.chainKey] }));

describe('portfolio totals with many accounts (§2.9)', () => {
  it('adds every account once: 20 Bitcoin accounts of 0.1 BTC', () => {
    const r = run(
      btcAccounts(20),
      Array.from({ length: 20 }, (_, i) => [`btc:${i}`, btc.id, 10_000_000n] as [string, string, bigint]),
    );
    const agg = r.holdings.find((h) => h.asset.id === btc.id);
    expect(agg?.amount).toBe(200_000_000n);
    expect(r.total).toBeCloseTo(2 * 50_000, 6);
    const rows = r.accountHoldings.filter((h) => h.asset.id === btc.id);
    expect(rows).toHaveLength(20);
    expect(rows.every((h) => h.account && h.amount === 10_000_000n)).toBe(true);
    expect(rows.reduce((s, h) => s + h.share, 0)).toBeCloseTo(agg?.share ?? 0, 9);
    expect(r.change24hFiat).toBeCloseTo(100_000 - 100_000 / 1.1, 6);
  });

  it('a removed account (stale balance key) and a duplicated source are not counted', () => {
    const sources = [...btcAccounts(2), btcAccounts(2)[1] as HoldingSource];
    const r = run(sources, [
      ['btc:0', btc.id, 100_000_000n],
      ['btc:1', btc.id, 50_000_000n],
      ['btc:7', btc.id, 999_000_000n],
    ]);
    expect(r.holdings.find((h) => h.asset.id === btc.id)?.amount).toBe(150_000_000n);
    expect(r.accountHoldings.filter((h) => h.asset.id === btc.id)).toHaveLength(2);
    expect(r.total).toBeCloseTo(1.5 * 50_000, 6);
  });

  it('one account: a single row, no per-account split; mixed chains add up', () => {
    const r = run(
      [btcAccounts(1)[0] as HoldingSource, { family: 'sol', index: 0, name: 'Solana 1', chainKeys: [sol.chainKey] }, { family: 'sol', index: 3, name: 'Solana 4', chainKeys: [sol.chainKey] }],
      [
        ['btc:0', btc.id, 100_000_000n],
        ['sol:0', sol.id, 2_000_000_000n],
        ['sol:3', sol.id, 3_000_000_000n],
      ],
    );
    expect(r.accountHoldings.filter((h) => h.asset.id === btc.id).map((h) => h.account)).toEqual([undefined]);
    expect(r.accountHoldings.filter((h) => h.asset.id === sol.id).map((h) => h.account?.name).sort()).toEqual(['Solana 1', 'Solana 4']);
    expect(r.total).toBeCloseTo(50_000 + 5 * 100, 6);
  });

  it('a failed chain keeps known balances and flags unknown ones', () => {
    const r = run(btcAccounts(2), [['btc:0', btc.id, 100_000_000n]], { [btc.chainKey]: 'Serveur injoignable' });
    const rows = r.accountHoldings.filter((h) => h.asset.id === btc.id);
    expect(rows.find((h) => h.account?.index === 0)?.failed).toBe(false);
    expect(rows.find((h) => h.account?.index === 1)?.failed).toBe(true);
    expect(r.holdings.find((h) => h.asset.id === btc.id)?.failed).toBe(false);
  });
});
