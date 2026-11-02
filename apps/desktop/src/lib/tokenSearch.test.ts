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

  it('shows XMR as a greyed « coming soon » source while no Monero fee address is configured', () => {
    expect(canSwapFrom(chains.find((c) => c.family === 'xmr'))).toBe(false);
    const sell = sellChoices('mainnet', chains, assets);
    const x = sell.filter((c) => c.chain.family === 'xmr');
    expect(x.map((c) => [c.asset.symbol, c.comingSoon])).toEqual([['XMR', true]]);
    expect(sell.filter((c) => c.comingSoon)).toHaveLength(1);
    const entries = sell.map((c) => ({ id: c.asset.id, symbol: c.asset.symbol, name: c.asset.name, network: c.chain.label, disabled: c.comingSoon }));
    expect(searchTokens(entries, 'monero').map((x) => [x.symbol, x.disabled])).toEqual([['XMR', true]]);
    // Arrival-only Exolix chains never show up as sources.
    expect(sell.some((c) => ['kas', 'algo', 'near'].includes(c.chain.family))).toBe(false);
    expect(sellChoices('testnet', allChains('testnet'), assetsFor('testnet')).some((c) => c.comingSoon)).toBe(false);
  });

  it('reaches Kaspa, Algorand and NEAR as destinations (Exolix), not as sources', () => {
    const eth = assets.find((a) => a.chainKey === 'ethereum' && a.kind === 'native');
    const keys = buyGroups('mainnet', chains, assets, eth).map((g) => g.chain.key);
    for (const k of ['monero', 'kaspa', 'algorand', 'near']) expect(keys, k).toContain(k);
    const kas = buyGroups('mainnet', chains, assets, eth).find((g) => g.chain.key === 'kaspa');
    expect(kas?.assets.every((a) => a.kind === 'native') ?? false).toBe(true);
  });
});
