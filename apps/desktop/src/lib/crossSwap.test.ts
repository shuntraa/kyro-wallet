import { describe, expect, it } from 'vitest';
import { allChains, assetsFor, findChain } from '@kyro/chains';
import { buyGroups, canSwapFrom, canSwapTo, crossStatusLabel, ownAddressOn, swapChainOf, swapTokenAddress } from './crossSwap';
import { isLocalTx } from './storage';

const accounts = {
  evm: { address: '0x4F2A9c83b1E07D6a55C0E91B3D7f28aE6c19d7b2', path: '' },
  sol: { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', path: '' },
  btc: { segwit: { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', xpub: '', fingerprint: '', path: '' }, taproot: { address: 'bc1p…', xpub: '', fingerprint: '', path: '' } },
};

describe('cross-chain swap helpers', () => {
  const chains = allChains('mainnet');
  const assets = assetsFor('mainnet');
  const eth = findChain('mainnet', 'ethereum');
  const sol = findChain('mainnet', 'solana');
  const btc = findChain('mainnet', 'bitcoin');

  it('maps chains to swap ids and own addresses (never typed: always one of your accounts)', () => {
    expect(swapChainOf(eth)).toBe(1);
    expect(swapChainOf(sol)).toBe('solana');
    expect(swapChainOf(btc)).toBe('bitcoin');
    expect(swapChainOf(findChain('mainnet', 'tron'))).toBeNull();
    expect(ownAddressOn(accounts, sol)).toBe(accounts.sol.address);
    expect(ownAddressOn(accounts, btc)).toBe(accounts.btc.segwit.address); // native SegWit, not Taproot
    expect(ownAddressOn(accounts, findChain('mainnet', 'xrp'))).toBeNull();
  });

  it('starts on EVM / Solana only; arrives on another chain on mainnet only', () => {
    expect(canSwapFrom(btc)).toBe(false);
    expect(canSwapFrom(sol)).toBe(true);
    expect(canSwapTo('mainnet', eth, sol)).toBe(true);
    expect(canSwapTo('mainnet', sol, btc)).toBe(true);
    expect(canSwapTo('mainnet', btc, eth)).toBe(false);
    expect(canSwapTo('mainnet', eth, findChain('mainnet', 'tron'))).toBe(false);
    const sep = findChain('testnet', 'sepolia');
    expect(canSwapTo('testnet', sep, findChain('testnet', 'solana'))).toBe(false);
    expect(canSwapTo('testnet', sep, sep)).toBe(true);
  });

  it('« Tu reçois » groups: the sell chain first, then the others, without the sold asset', () => {
    const sell = assets.find((a) => a.id === 'eth:1');
    const groups = buyGroups('mainnet', chains, assets, sell);
    expect(groups[0]?.chain.key).toBe('ethereum');
    expect(groups.map((g) => g.chain.key)).toEqual(expect.arrayContaining(['solana', 'bitcoin', 'arbitrum']));
    expect(groups.some((g) => ['tron', 'xrp', 'ada', 'ltc', 'doge'].includes(g.chain.family))).toBe(false);
    expect(groups.flatMap((g) => g.assets).some((a) => a.id === 'eth:1')).toBe(false);
    // Testnet: same chain only.
    const sepEth = assetsFor('testnet').find((a) => a.chainKey === 'sepolia' && a.kind === 'native');
    expect(buyGroups('testnet', allChains('testnet'), assetsFor('testnet'), sepEth).map((g) => g.chain.key)).toEqual(['sepolia']);
  });

  it('token ids as the providers name them', () => {
    const find = (id: string) => assets.find((a) => a.id === id);
    expect(swapTokenAddress(find('sol') ?? assets[0]!)).toBe('So11111111111111111111111111111111111111112');
    expect(swapTokenAddress(find('btc') ?? assets[0]!)).toBe('bitcoin');
    expect(swapTokenAddress(find('eth:1') ?? assets[0]!)).toBe('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
  });

  it('labels the bridge status and stores it safely', () => {
    expect(crossStatusLabel(undefined, 'Solana')).toBe('en route vers Solana');
    expect(crossStatusLabel('DONE', 'Solana')).toBe('arrivé sur Solana');
    expect(crossStatusLabel('FAILED', 'Solana')).toMatch(/remboursement/);
    const tx = { id: '0xabc', network: 'mainnet', chainKey: 'arbitrum', assetId: 'eth:42161', kind: 'swap', direction: 'out', amount: '1', time: 1, status: 'pending' };
    expect(isLocalTx({ ...tx, cross: { fromChain: '42161', toChain: 'solana', toChainKey: 'solana', bridge: 'near' } }, 'mainnet')).toBe(true);
    expect(isLocalTx({ ...tx, cross: { fromChain: '42161', toChain: 'tron', toChainKey: 'solana', bridge: 'near' } }, 'mainnet')).toBe(false);
    expect(isLocalTx({ ...tx, cross: { fromChain: '42161', toChain: 'solana', toChainKey: 'solana', bridge: 'near', status: '<script>' } }, 'mainnet')).toBe(false);
  });
});
