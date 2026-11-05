import { describe, expect, it } from 'vitest';
import { allChains, assetsFor, parseUnits, type AssetDef } from '@kyro/chains';
import { currentItem, runFinished, settle, settleAndStop, startRun, stopRun, suspectAssetIds, TIDY_DEFAULT_THRESHOLD, TIDY_MAX_FEE_RATIO, tickedByDefault, tidyCost, tidyRows, tidySummary, type TidyInput } from './tidy';
import { AAVE_MARKETS, LIDO_STETH } from './earn';
import { nativeFloor } from './topUp';

const chains = allChains('mainnet');
const assets = assetsFor('mainnet');
const asset = (chainKey: string, symbol: string): AssetDef => {
  const a = assets.find((x) => x.chainKey === chainKey && x.symbol === symbol);
  if (!a) throw new Error(`${symbol} on ${chainKey}`);
  return a;
};
const arbEth = asset('arbitrum', 'ETH');
const arbUsdc = asset('arbitrum', 'USDC');
const arbUsdt = asset('arbitrum', 'USDT');
const baseUsdc = asset('base', 'USDC');
const baseEth = asset('base', 'ETH');
// Cronos: same-chain swaps only, so nothing there reaches a target on Base.
const cronosCoin = assets.find((a) => a.chainKey === 'cronos' && a.kind === 'native') as AssetDef;
const cronosToken = assets.find((a) => a.chainKey === 'cronos' && a.kind !== 'native') as AssetDef;

const fee = parseUnits('0.0001', 18);

function input(held: Array<[AssetDef, string]>, over: Partial<TidyInput> = {}): TidyInput {
  const balances = new Map(held.map(([a, v]) => [a.id, parseUnits(v, a.decimals)]));
  return {
    network: 'mainnet',
    chains,
    assets,
    target: baseUsdc,
    threshold: TIDY_DEFAULT_THRESHOLD,
    balanceOf: (id) => balances.get(id) ?? 0n,
    priceOf: (a) => (a.coingeckoId === 'ethereum' ? 3000 : a.coingeckoId === 'usd-coin' || a.coingeckoId === 'tether' ? 1 : 2),
    feeOf: (a) => (a.family === 'evm' ? fee : parseUnits('0.1', a.decimals)),
    suspects: new Set(),
    canSign: () => true,
    ...over,
  };
}

const ids = (i: TidyInput) => tidyRows(i).map((r) => r.asset.id);

describe('eligible balances', () => {
  it('lists balances at or under the threshold, never empty or larger ones', () => {
    const i = input([[arbEth, '1'], [arbUsdc, '4'], [arbUsdt, '5.01']]);
    expect(ids(i)).toEqual([arbUsdc.id]);
    expect(ids({ ...i, threshold: 6 })).toEqual([arbUsdt.id, arbUsdc.id]);
  });

  it('leaves out the target, flagged assets, unpriced assets and what cannot be signed', () => {
    const held: Array<[AssetDef, string]> = [[arbEth, '1'], [arbUsdc, '4'], [baseUsdc, '4'], [baseEth, '1']];
    expect(ids(input(held))).toEqual([arbUsdc.id]);
    expect(ids(input(held, { suspects: new Set([arbUsdc.id]) }))).toEqual([]);
    expect(ids(input(held, { priceOf: (a) => (a.id === arbUsdc.id ? null : 3000) }))).toEqual([]);
    expect(ids(input(held, { canSign: () => false }))).toEqual([]);
  });

  it('leaves out read-only assets and receipts of staked or lent funds', () => {
    const steth: AssetDef = { ...arbUsdc, id: 'erc20:1:steth', contract: LIDO_STETH };
    const aToken: AssetDef = { ...arbUsdc, id: 'erc20:42161:ausdc', contract: (AAVE_MARKETS['usdc-aave-arb'] as { aToken: string }).aToken.toUpperCase().replace('0X', '0x') };
    const readOnly: AssetDef = { ...arbUsdc, id: 'erc20:42161:ro', readOnly: true };
    const list = [...assets, steth, aToken, readOnly];
    const i = input([[steth, '4'], [aToken, '4'], [readOnly, '4'], [arbEth, '1']], { assets: list });
    expect(ids(i)).toEqual([]);
  });

  it('shows tokens of chains without a route as not convertible, not hidden', () => {
    const rows = tidyRows(input([[cronosCoin, '1'], [cronosToken, '1']]));
    expect(rows.map((r) => [r.asset.id, r.block])).toEqual([[cronosToken.id, 'noRoute'], [cronosCoin.id, 'noRoute']]);
  });

  it('flags a token whose chain has no coin left for its fee', () => {
    const rows = tidyRows(input([[arbUsdc, '4']]));
    expect(rows.map((r) => [r.asset.id, r.block])).toEqual([[arbUsdc.id, 'noFees']]);
  });

  it('spends the native coin on the tokens first, and flags the ones it cannot pay for', () => {
    const rows = tidyRows(input([[arbEth, '0.00015'], [arbUsdc, '4'], [arbUsdt, '3']]));
    expect(rows.map((r) => [r.asset.id, r.block])).toEqual([[arbUsdc.id, null], [arbUsdt.id, 'noFees']]);
  });
});

describe('native coins', () => {
  it('keep a reserve: only what is above it is sold, after the tokens', () => {
    const rows = tidyRows(input([[arbEth, '0.001'], [arbUsdc, '4']]));
    expect(rows.map((r) => r.asset.id)).toEqual([arbUsdc.id, arbEth.id]);
    // 0.001 less the token's swap, its own swap and one more.
    expect(rows[1]?.amount).toBe(parseUnits('0.001', 18) - fee * 3n);
    expect(rows[1]?.value).toBeCloseTo(2.1);
  });

  it('stay out of the list when all of it is needed for fees', () => {
    expect(ids(input([[arbEth, '0.0002']]))).toEqual([]);
  });

  it('never go under what the chain itself keeps', () => {
    const xrp = assets.find((a) => a.family === 'xrp' && a.kind === 'native') as AssetDef;
    const rows = tidyRows(input([[xrp, '1.5']]));
    expect(rows[0]?.amount).toBe(parseUnits('1.5', 6) - nativeFloor(xrp) - parseUnits('0.1', 6) * 2n);
    expect(ids(input([[xrp, '1']]))).toEqual([]);
  });
});

describe('the 30 % rule', () => {
  it('counts what is lost in the swap and the network fee', () => {
    const c = tidyCost({ value: 10, received: 9, networkFee: 0.5 });
    expect(c?.net).toBeCloseTo(8.5);
    expect(c?.fees).toBeCloseTo(1.5);
    expect(c?.ratio).toBeCloseTo(0.15);
  });

  it('keeps ticked up to exactly 30 %, unticks above', () => {
    expect(TIDY_MAX_FEE_RATIO).toBe(0.3);
    expect(tickedByDefault(tidyCost({ value: 10, received: 8, networkFee: 1 }))).toBe(true);
    expect(tickedByDefault(tidyCost({ value: 10, received: 8, networkFee: 1.01 }))).toBe(false);
    expect(tickedByDefault(tidyCost({ value: 1, received: 0.9, networkFee: 3 }))).toBe(false);
  });

  it('never ticks a conversion of unknown cost', () => {
    expect(tidyCost({ value: 10, received: null, networkFee: 1 })).toBeNull();
    expect(tidyCost({ value: 10, received: 9, networkFee: null })).toBeNull();
    expect(tickedByDefault(null)).toBe(false);
  });

  it('never counts a gain as negative fees', () => {
    expect(tidyCost({ value: 10, received: 11, networkFee: 0 })?.fees).toBe(0);
  });
});

describe('flagged assets', () => {
  const fiat = (e: { amount: bigint }) => Number(e.amount);
  const entry = (assetId: string, o: { direction?: string; kind?: string; amount?: bigint; suspect?: 'zero' | 'notSigned' } = {}) => ({ assetId, asset: arbUsdc, direction: 'in', kind: 'transfer', amount: 100n, ...o });

  it('flags an asset seen only through lures', () => {
    expect([...suspectAssetIds([entry('a', { suspect: 'zero' }), entry('b', { amount: 0n })], fiat)].sort()).toEqual(['a', 'b']);
  });

  it('clears an asset with one real movement', () => {
    expect(suspectAssetIds([entry('a', { suspect: 'zero' }), entry('a')], fiat).size).toBe(0);
    expect(suspectAssetIds([entry('a', { amount: 0n }), entry('a', { direction: 'out', amount: 0n })], fiat).size).toBe(0);
  });
});

describe('a run', () => {
  it('goes on after a failure and sums everything up', () => {
    let run = startRun(['a', 'b', 'c', 'd']);
    expect(currentItem(run)).toBe('a');
    run = settle(run, 0, { status: 'failed', reason: 'simulation failed' });
    expect(currentItem(run)).toBe('b');
    run = settle(run, 1, { status: 'done', id: '0xabc' });
    run = settle(run, 2, { status: 'skipped' });
    expect(runFinished(run)).toBe(false);
    run = settle(run, 3, { status: 'failed', reason: 'no quote' });
    expect(runFinished(run)).toBe(true);
    expect(currentItem(run)).toBeUndefined();
    expect(tidySummary(run)).toEqual({ done: ['b'], failed: [{ item: 'a', reason: 'simulation failed' }, { item: 'd', reason: 'no quote' }], skipped: ['c'] });
  });

  it('ignores an answer for an item already settled', () => {
    const run = settle(startRun(['a', 'b']), 0, { status: 'done', id: '1' });
    expect(settle(run, 0, { status: 'failed', reason: 'late' })).toBe(run);
    const end = settle(run, 1, { status: 'done', id: '2' });
    expect(settle(end, 2, { status: 'skipped' })).toBe(end);
  });

  it('over the limit: this one fails, the rest is skipped, no other swap is tried', () => {
    const run = settle(startRun(['a', 'b', 'c']), 0, { status: 'done', id: '1' });
    const end = settleAndStop(run, 1, { status: 'failed', reason: 'limit' });
    expect(runFinished(end)).toBe(true);
    expect(tidySummary(end)).toEqual({ done: ['a'], failed: [{ item: 'b', reason: 'limit' }], skipped: ['c'] });
  });

  it('an answer arriving after a stop changes nothing', () => {
    const stopped = stopRun(startRun(['a', 'b']));
    expect(settle(stopped, 0, { status: 'failed', reason: 'late' })).toBe(stopped);
    expect(settleAndStop(stopped, 0, { status: 'failed', reason: 'late' })).toBe(stopped);
  });

  it('stopping skips what is left and keeps what is done', () => {
    const run = stopRun(settle(startRun(['a', 'b', 'c']), 0, { status: 'done', id: '1' }));
    expect(runFinished(run)).toBe(true);
    expect(tidySummary(run)).toEqual({ done: ['a'], failed: [], skipped: ['b', 'c'] });
  });
});
