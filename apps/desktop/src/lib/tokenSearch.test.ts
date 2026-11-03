import { describe, expect, it } from 'vitest';
import { allChains, assetsFor } from '@kyro/chains';
import { matchScore, searchTokens, type PickerEntry } from './tokenSearch';
import { buyGroups, canSwapFrom, sellChoices } from './crossSwap';

const e = (id: string, symbol: string, name: string, network: string, extra: Partial<PickerEntry> = {}): PickerEntry => ({ id, symbol, name, network, ...extra });

describe('swap token picker search', () => {
  const list = [
    e('usdc', 'USDC', 'USD Coin', 'Ethereum'),
    e('mon', 'MON', 'Monad', 'Monad'),
    e('xmr', 'XMR', 'Monero', 'XMR'),
    e('eth-arb', 'ETH', 'Ethereum', 'Arbitrum', { networkName: 'Arbitrum One' }),
    e('btc', 'BTC', 'Bitcoin', 'BTC'),
    e('gram', 'GRAM', 'Gram', 'TON', { coingeckoId: 'the-open-network' }),
  ];

  it('finds by ticker, name prefix, former name and network', () => {
    expect(searchTokens(list, 'XMR').map((x) => x.id)).toEqual(['xmr']);
    expect(searchTokens(list, 'mon').map((x) => x.id)).toEqual(['mon', 'xmr']);
    expect(searchTokens(list, '  monero ').map((x) => x.id)).toEqual(['xmr']);
    expect(searchTokens(list, 'toncoin').map((x) => x.id)).toEqual(['gram']);
    expect(searchTokens(list, 'arbitrum').map((x) => x.id)).toEqual(['eth-arb']);
    expect(searchTokens(list, 'zzz')).toEqual([]);
    expect(matchScore(list[2] as PickerEntry, 'xmr')).toBeGreaterThan(matchScore(list[1] as PickerEntry, 'xm'));
  });

  it('puts recent, then held, then popular first; greyed entries last', () => {
    expect(searchTokens(list, '').map((x) => x.id).slice(0, 3)).toEqual(['btc', 'eth-arb', 'usdc']);
    expect(searchTokens(list, '', ['mon']).map((x) => x.id)[0]).toBe('mon');
    expect(searchTokens([...list, e('kas', 'KAS', 'Kaspa', 'KAS', { held: true })], '').map((x) => x.id)[0]).toBe('kas');
    expect(searchTokens(list.map((x) => (x.id === 'btc' ? { ...x, disabled: true } : x)), '').at(-1)?.id).toBe('btc');
  });
});

describe('Monero in the swap picker', () => {
  const chains = allChains('mainnet');
  const assets = assetsFor('mainnet');
  const xmr = assets.find((a) => a.family === 'xmr' && a.kind === 'native');

  it('lists XMR as a destination from the main sources, and a search finds it', () => {
    for (const id of ['native:ethereum', 'native:arbitrum', 'native:base', 'native:bitcoin', 'native:solana', 'native:tron', 'native:dogecoin']) {
      const sell = assets.find((a) => a.chainKey === id.split(':')[1] && a.kind === 'native');
      const entries = buyGroups('mainnet', chains, assets, sell).flatMap((g) => g.assets.map((a) => ({ id: a.id, symbol: a.symbol, name: a.name, network: g.chain.label })));
      expect(searchTokens(entries, 'xmr').map((x) => x.id), id).toContain(xmr?.id);
    }
  });

  it('offers swaps FROM Monero, Kaspa, Algorand and NEAR (native coin only) now that Kyro has fee addresses there', () => {
    const sell = sellChoices('mainnet', chains, assets);
    for (const f of ['xmr', 'kas', 'algo', 'near'] as const) {
      expect(canSwapFrom(chains.find((c) => c.family === f)), f).toBe(true);
      const x = sell.filter((c) => c.chain.family === f);
      expect(x.length, f).toBeGreaterThan(0);
      expect(x.every((c) => !c.comingSoon && c.asset.kind === 'native'), f).toBe(true);
    }
    expect(sell.some((c) => c.comingSoon)).toBe(false);
    expect(sellChoices('testnet', allChains('testnet'), assetsFor('testnet')).some((c) => c.comingSoon)).toBe(false);
  });

  it('reaches Kaspa, Algorand and NEAR as destinations (Exolix)', () => {
    const eth = assets.find((a) => a.chainKey === 'ethereum' && a.kind === 'native');
    const keys = buyGroups('mainnet', chains, assets, eth).map((g) => g.chain.key);
    for (const k of ['monero', 'kaspa', 'algorand', 'near']) expect(keys, k).toContain(k);
    const kas = buyGroups('mainnet', chains, assets, eth).find((g) => g.chain.key === 'kaspa');
    expect(kas?.assets.every((a) => a.kind === 'native') ?? false).toBe(true);
  });
});
