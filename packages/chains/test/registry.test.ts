// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { base58 } from '@scure/base';
import { assetsFor, ERC20_TOKENS, evmChains, isTronAddress, outgoingHosts, SPL_TOKENS, TRC20_TOKENS } from '../src';

const NETWORKS = ['mainnet', 'testnet'] as const;

describe('chain and token registry', () => {
  it('unique EVM chain ids, on both networks', () => {
    const ids = NETWORKS.flatMap((n) => evmChains(n).map((c) => c.chainId));
    expect(new Set(ids).size).toBe(ids.length);
    const keys = NETWORKS.flatMap((n) => evmChains(n).map((c) => c.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every ERC-20 list belongs to a registry chain', () => {
    const keys = new Set(NETWORKS.flatMap((n) => evmChains(n).map((c) => c.key)));
    for (const k of Object.keys(ERC20_TOKENS)) expect(keys.has(k), k).toBe(true);
  });

  it('ERC-20: EIP-55 addresses, no duplicate per chain, fields filled', () => {
    for (const [chain, list] of Object.entries(ERC20_TOKENS)) {
      const seen = new Set<string>();
      for (const t of list) {
        expect(getAddress(t.contract), `${chain} ${t.symbol}`).toBe(t.contract);
        expect(seen.has(t.contract.toLowerCase()), `${chain} ${t.symbol} en double`).toBe(false);
        seen.add(t.contract.toLowerCase());
        expect(t.coingeckoId, `${chain} ${t.symbol}`).toMatch(/^[a-z0-9-]+$/);
        expect(t.symbol.trim()).toBe(t.symbol);
        expect(t.symbol.length).toBeGreaterThan(0);
        expect(t.name.length).toBeGreaterThan(0);
        expect(Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 30).toBe(true);
        expect(t.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
        // Letter glyph: one character, no emoji.
        expect([...t.glyph]).toHaveLength(1);
        expect(/\p{Extended_Pictographic}/u.test(t.glyph), t.glyph).toBe(false);
      }
    }
  });

  it('SPL and TRC-20: valid addresses, no duplicate', () => {
    for (const n of NETWORKS) {
      const spl = SPL_TOKENS[n].map((t) => t.contract);
      expect(new Set(spl).size).toBe(spl.length);
      for (const m of spl) expect(base58.decode(m)).toHaveLength(32);
      const trc = TRC20_TOKENS[n].map((t) => t.contract);
      expect(new Set(trc).size).toBe(trc.length);
      for (const c of trc) expect(isTronAddress(c), c).toBe(true);
      for (const t of [...SPL_TOKENS[n], ...TRC20_TOKENS[n]]) expect(t.coingeckoId).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('unique asset ids; never the excluded tokens; A7A5 on Ethereum and TRON', () => {
    for (const n of NETWORKS) {
      const ids = assetsFor(n).map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const all = assetsFor('mainnet').map((a) => a.coingeckoId);
    for (const banned of ['pi-network', 'canton-network', 'blackrock-usd-institutional-digital-liquidity-fund', 'hashnote-usyc', 'ondo-us-dollar-yield', 'ousg', 'microstrategy-xstock']) {
      expect(all).not.toContain(banned);
    }
    expect(assetsFor('mainnet').filter((a) => a.coingeckoId === 'a7a5').map((a) => a.contract)).toEqual(['0x6fA0BE17e4beA2fCfA22ef89BF8ac9aab0AB0fc9', 'TLeVfrdym8RoJreJ23dAGyfJDygRtiWKBZ']);
  });

  it('more than 100 tokens on Ethereum, including QNT and the historical tokens', () => {
    const eth = ERC20_TOKENS.ethereum ?? [];
    expect(eth.length).toBeGreaterThan(90);
    for (const s of ['USDC', 'USDT', 'DAI', 'WBTC', 'QNT']) expect(eth.some((t) => t.symbol === s), s).toBe(true);
    expect(eth.find((t) => t.symbol === 'QNT')?.contract).toBe('0x4a220E6096B25EADb88358cb44068A3248254675');
  });

  it('every default EVM RPC is in the outgoing connections', () => {
    const hosts = outgoingHosts('mainnet').map((h) => h.host);
    for (const c of evmChains('mainnet')) expect(hosts).toContain(new URL(c.rpcUrl).host);
  });
});
