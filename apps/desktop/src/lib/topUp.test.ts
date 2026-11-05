import { describe, expect, it } from 'vitest';
import { allChains, assetsFor, parseUnits, type AssetDef } from '@kyro/chains';
import type { Quote } from '@kyro/swap';
import { missingFee, minSwapFiat, nativeFloor, pickTopUpRoute, quoteMinimum, swapFeeOn, TOP_UP_COST, TOP_UP_MARGIN, TOP_UP_MIN_USD, topUpSellAmount, topUpSources, type TopUpInput, type TopUpSource } from './topUp';

const chains = allChains('mainnet');
const assets = assetsFor('mainnet');
const asset = (chainKey: string, symbol: string): AssetDef => {
  const a = assets.find((x) => x.chainKey === chainKey && x.symbol === symbol);
  if (!a) throw new Error(`${symbol} on ${chainKey}`);
  return a;
};
const eth = asset('ethereum', 'ETH');
const arbEth = asset('arbitrum', 'ETH');
const arbUsdc = asset('arbitrum', 'USDC');
const baseEth = asset('base', 'ETH');
const baseUsdc = asset('base', 'USDC');
const ethUsdc = asset('ethereum', 'USDC');
const sol = asset('solana', 'SOL');
const btc = assets.find((a) => a.chainKey === 'bitcoin' && a.kind === 'native') as AssetDef;

const PRICES: Record<string, number> = { ethereum: 3000, 'usd-coin': 1, tether: 1, solana: 150, bitcoin: 90_000 };

function input(held: Array<[AssetDef, string]>, over: Partial<TopUpInput> = {}): TopUpInput {
  const balances = new Map(held.map(([a, v]) => [a.id, parseUnits(v, a.decimals)]));
  return {
    network: 'mainnet',
    chains,
    assets,
    target: eth,
    missing: parseUnits('0.001', 18),
    balanceOf: (id) => balances.get(id) ?? 0n,
    priceOf: (a) => PRICES[a.coingeckoId] ?? null,
    // 0.00001 of the native coin per swap, whatever the chain.
    feeOf: (a) => parseUnits('0.00001', assets.find((x) => x.chainKey === a.chainKey && x.kind === 'native')?.decimals ?? 18),
    canUse: () => true,
    usdToFiat: 1,
    ...over,
  };
}

describe('source of a missing network fee', () => {
  it('never picks the chain that lacks the coin, even with plenty of tokens there', () => {
    expect(topUpSources(input([[ethUsdc, '5000']]))).toEqual([]);
  });

  it('takes a token on another chain only when that chain can pay its own fee', () => {
    expect(topUpSources(input([[arbUsdc, '500']]))).toEqual([]);
    const ok = topUpSources(input([[arbUsdc, '500'], [arbEth, '0.01']]));
    expect(ok.map((s) => s.asset.id)).toContain(arbUsdc.id);
    expect(ok[0]?.asset.id).toBe(arbUsdc.id);
  });

  it('prefers a stablecoin to a volatile coin at the same cost, then the largest holding', () => {
    const list = topUpSources(input([[arbUsdc, '200'], [arbEth, '1'], [baseUsdc, '900'], [baseEth, '0.01']]));
    expect(list.slice(0, 2).map((s) => s.asset.id)).toEqual([baseUsdc.id, arbUsdc.id]);
  });

  it('puts the cheapest source chain first', () => {
    const fee = (a: AssetDef) => parseUnits(a.chainKey === 'base' ? '0.001' : '0.00001', 18);
    const list = topUpSources(input([[arbEth, '1'], [baseEth, '1']], { feeOf: fee }));
    expect(list[0]?.asset.id).toBe(arbEth.id);
  });

  it('keeps the fee and the floor of a native source out of what it can sell', () => {
    const s = topUpSources(input([[sol, '1']], { feeOf: () => parseUnits('0.01', 9) }))[0] as TopUpSource;
    expect(s.asset.id).toBe(sol.id);
    expect(s.maxSell).toBe(parseUnits('1', 9) - parseUnits('0.01', 9) - nativeFloor(sol));
  });

  it('drops a source too small to reach the amount, the minimum included', () => {
    expect(topUpSources(input([[arbEth, '0.001']]))).toEqual([]);
    expect(topUpSources(input([[arbUsdc, '3'], [arbEth, '0.0001']]))).toEqual([]);
  });

  it('drops a source without an account, without a known fee or without a price', () => {
    const held: Array<[AssetDef, string]> = [[arbUsdc, '500'], [arbEth, '0.01']];
    expect(topUpSources(input(held, { canUse: (c) => c.key !== 'arbitrum' }))).toEqual([]);
    expect(topUpSources(input(held, { feeOf: () => null }))).toEqual([]);
    expect(topUpSources(input(held, { priceOf: () => null }))).toEqual([]);
  });

  it('finds nothing when nothing is held, or for a chain no cross-chain route reaches', () => {
    expect(topUpSources(input([]))).toEqual([]);
    const cronos = assets.find((a) => a.chainKey === 'cronos' && a.kind === 'native') as AssetDef;
    expect(topUpSources(input([[arbUsdc, '500'], [arbEth, '1'], [btc, '1']], { target: cronos }))).toEqual([]);
  });

  it('finds nothing on testnet: no cross-chain route there', () => {
    const tChains = allChains('testnet');
    const tAssets = assetsFor('testnet');
    const target = tAssets.find((a) => a.family === 'evm' && a.kind === 'native') as AssetDef;
    const other = tAssets.find((a) => a.family === 'evm' && a.kind === 'native' && a.chainKey !== target.chainKey);
    expect(topUpSources(input(other ? [[other, '1']] : [], { network: 'testnet', chains: tChains, assets: tAssets, target }))).toEqual([]);
  });

  it('nothing is asked when no coin is missing', () => {
    expect(missingFee(100n, 100n)).toBe(0n);
    expect(missingFee(100n, 130n)).toBe(0n);
    expect(missingFee(100n, 30n)).toBe(70n);
    expect(topUpSources(input([[arbEth, '1']], { missing: 0n }))).toEqual([]);
  });
});

describe('amount of a top-up', () => {
  const base = { target: { decimals: 18 }, targetPrice: 3000, sell: { decimals: 6 }, sellPrice: 1 };

  it('covers the missing fee with its margin and the cost of the swap', () => {
    const missing = parseUnits('0.01', 18); // 30 of fiat
    const amount = topUpSellAmount({ ...base, missing, minFiat: 10 }) as bigint;
    const expected = (30 * (1 + TOP_UP_MARGIN)) / (1 - TOP_UP_COST);
    expect(Number(amount) / 1e6).toBeCloseTo(expected, 4);
    // What arrives after the swap's cost still covers the fee, with the margin.
    expect((Number(amount) / 1e6) * (1 - TOP_UP_COST)).toBeGreaterThanOrEqual(30 * (1 + TOP_UP_MARGIN) - 0.001);
  });

  it('stays above the minimum of the route', () => {
    const amount = topUpSellAmount({ ...base, missing: parseUnits('0.0001', 18), minFiat: 10 }) as bigint;
    expect(amount).toBe(10_000_000n);
    const tron = chains.find((c) => c.family === 'tron');
    const arb = chains.find((c) => c.key === 'arbitrum');
    expect(tron && minSwapFiat(tron, 1)).toBe(100);
    expect(arb && minSwapFiat(arb, 0.9)).toBeCloseTo(TOP_UP_MIN_USD * 0.9);
  });

  it('gives nothing without both prices', () => {
    expect(topUpSellAmount({ ...base, targetPrice: null, missing: 1n, minFiat: 10 })).toBeNull();
    expect(topUpSellAmount({ ...base, sellPrice: 0, missing: 1n, minFiat: 10 })).toBeNull();
    expect(topUpSellAmount({ ...base, missing: 0n, minFiat: 10 })).toBeNull();
  });
});

describe('network fee estimates', () => {
  const estimates = (maxFeePerGas: bigint) => ({ options: { normal: { params: { family: 'evm' as const, maxFeePerGas, maxPriorityFeePerGas: 1n } } } }) as never;

  it('prices EVM swaps from the fee level, an approval included for tokens', () => {
    const plain = swapFeeOn(eth, { token: true, plain: true, estimates: estimates(10n) }) as bigint;
    const native = swapFeeOn(eth, { token: false, estimates: estimates(10n) }) as bigint;
    const token = swapFeeOn(eth, { token: true, estimates: estimates(10n) }) as bigint;
    expect(plain).toBeLessThan(native);
    expect(token).toBeGreaterThan(native);
  });

  it('falls back on a fiat value, and never calls an unknown EVM fee free', () => {
    expect(swapFeeOn(eth, { token: true, nativePrice: 3000 })).toBe(parseUnits('0.001', 18));
    expect(swapFeeOn(eth, { token: true })).toBeNull();
  });

  it('has a usual cost for every native coin but the ones priced live', () => {
    for (const a of assets.filter((x) => x.kind === 'native' && x.family !== 'evm')) expect(swapFeeOn(a, { token: false }), a.id).not.toBeNull();
  });
});

describe('checking a source against live quotes', () => {
  const missing = 1_000n;
  const source = (id: string, sellAmount = 100n, maxSell = 1_000n): TopUpSource => ({ asset: { ...arbUsdc, id }, chain: chains[0] as never, sellAmount, maxSell, sellFiat: 10, feeFiat: 0 });
  const quote = (minBuyAmount: bigint) => ({ minBuyAmount }) as Quote;

  it('moves past a source no provider quotes, and returns the next one', async () => {
    const seen: string[] = [];
    const route = await pickTopUpRoute([source('a'), source('b')], missing, async (s) => {
      seen.push(s.asset.id);
      return s.asset.id === 'a' ? { quotes: [], results: [{ provider: 'near', providerName: 'NEAR', error: 'no route' }] } : { quotes: [quote(2_000n)], results: [] };
    });
    expect(seen).toEqual(['a', 'b']);
    expect(route?.source.asset.id).toBe('b');
  });

  it('survives a probe that throws', async () => {
    const route = await pickTopUpRoute([source('a'), source('b')], missing, async (s) => {
      if (s.asset.id === 'a') throw new Error('offline');
      return { quotes: [quote(2_000n)], results: [] };
    });
    expect(route?.source.asset.id).toBe('b');
  });

  it('asks again above a minimum given by the provider, within what can be sold', async () => {
    const asked: bigint[] = [];
    const route = await pickTopUpRoute([source('a')], missing, async (_s, amount) => {
      asked.push(amount);
      return amount < 500n ? { quotes: [], results: [{ provider: 'near', providerName: 'NEAR', error: 'Amount is too low for bridge, try at least 500' }] } : { quotes: [quote(2_000n)], results: [] };
    });
    expect(asked).toEqual([100n, 510n]);
    expect(route?.sellAmount).toBe(510n);
  });

  it('gives up when the minimum is more than the source can sell', async () => {
    const route = await pickTopUpRoute([source('a', 100n, 400n)], missing, async () => ({ quotes: [], results: [{ provider: 'near', providerName: 'NEAR', error: 'try at least 500' }] }));
    expect(route).toBeNull();
  });

  it('scales up a quote whose guaranteed minimum does not cover the missing fee', async () => {
    const route = await pickTopUpRoute([source('a')], missing, async (_s, amount) => ({ quotes: [quote(amount * 5n)], results: [] }));
    expect(route?.sellAmount).toBe(240n);
    expect(route?.quote.minBuyAmount).toBeGreaterThanOrEqual(missing);
  });

  it('finds nothing in an empty list, and stops after a few sources', async () => {
    expect(await pickTopUpRoute([], missing, async () => ({ quotes: [], results: [] }))).toBeNull();
    let calls = 0;
    await pickTopUpRoute(['a', 'b', 'c', 'd', 'e', 'f'].map((x) => source(x)), missing, async () => {
      calls++;
      return { quotes: [], results: [] };
    });
    expect(calls).toBe(4);
  });

  it('reads the minimums of 1Click and Exolix, and nothing else', () => {
    expect(quoteMinimum('NEAR Intents: Amount is too low for bridge, try at least 1264000', 6)).toBe(1_264_000n);
    expect(quoteMinimum("Exolix: amount below Exolix's minimum (0.5)", 8)).toBe(50_000_000n);
    expect(quoteMinimum('montant sous le minimum d’Exolix (0.5)', 8)).toBe(50_000_000n);
    expect(quoteMinimum('no route', 6)).toBeNull();
    expect(quoteMinimum(undefined, 6)).toBeNull();
  });
});
