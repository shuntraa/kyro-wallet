import { describe, expect, it } from 'vitest';
import { assetsFor, type AssetDef } from '@kyro/chains';
import { assetGroupKey, dedupeByGroup, groupTotal, networkSiblings, otherNetworksForAddress } from './multiNetwork';

const all = assetsFor('mainnet');
const usdt = all.filter((a) => a.symbol === 'USDT' && a.coingeckoId === 'tether');
const byChain = (list: AssetDef[], key: string) => {
  const a = list.find((x) => x.chainKey === key);
  if (!a) throw new Error(key);
  return a;
};

describe('multi-network assets', () => {
  it('groups USDT across Ethereum, TRON, Solana, BNB Chain…', () => {
    const eth = byChain(usdt, 'ethereum');
    const sib = networkSiblings(eth, all);
    const chains = sib.map((a) => a.chainKey);
    for (const k of ['ethereum', 'tron', 'solana', 'bsc', 'polygon', 'arbitrum', 'avalanche']) expect(chains).toContain(k);
    expect(sib.every((a) => assetGroupKey(a) === assetGroupKey(eth))).toBe(true);
    // USDC is a different group.
    expect(sib.some((a) => a.symbol === 'USDC')).toBe(false);
  });

  it('shows each group once, the selected network or the largest balance standing for it', () => {
    const tron = byChain(usdt, 'tron');
    const bsc = byChain(usdt, 'bsc');
    const bal = (a: AssetDef) => (a.id === tron.id ? 5n : 0n);
    const list = dedupeByGroup(all, bal);
    expect(list.filter((a) => a.symbol === 'USDT' && a.coingeckoId === 'tether')).toEqual([tron]);
    expect(dedupeByGroup(all, bal, bsc.id).filter((a) => a.coingeckoId === 'tether')).toEqual([bsc]);
  });

  it('sums balances with different decimals (BNB Chain USDT has 18)', () => {
    const eth = byChain(usdt, 'ethereum');
    const bsc = byChain(usdt, 'bsc');
    const tot = groupTotal([eth, bsc], (a) => (a.id === eth.id ? 1_000_000n : 2n * 10n ** 18n));
    expect(tot).toEqual({ amount: 3n * 10n ** 18n, decimals: 18 });
  });

  it('points to the network an address belongs to', () => {
    const eth = byChain(usdt, 'ethereum');
    const tron = byChain(usdt, 'tron');
    const sib = networkSiblings(eth, all);
    const isValid = (a: AssetDef, x: string) => (a.family === 'tron' ? x.startsWith('T') : a.family === 'evm' ? x.startsWith('0x') : false);
    expect(otherNetworksForAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', eth, sib, isValid)).toEqual([tron]);
    expect(otherNetworksForAddress('0xabc', eth, sib, isValid)).toEqual([]);
    expect(otherNetworksForAddress('nope', eth, sib, isValid)).toEqual([]);
  });
});
