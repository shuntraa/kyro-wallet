// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { NetFetch } from '@kyro/shared';
import { EXOLIX_ARRIVAL_ONLY, ExolixProvider, exolixAsset, exolixFeeRecipients, exolixRoute, KYRO_SWAP_FEE, NATIVE_EVM, providerFee, validChainAddress, type QuoteParams } from '../src';

const OWN_XMR = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const OWN_EVM = '0x4F2A9c83b1E07D6a55C0E91B3D7f28aE6c19d7b2';
const OWN_KAS = 'kaspa:qypyrhxkfd055qulcvu6zccq4qe63qajrzgf7t4u4uusveguw6zzc3grrceeuex';
const OWN_ALGO = 'VCMJKWOY5P5P7SKMZFFOCEROPJCZOTIJMNIYNUCKH7LRO45JMJP6UYBIJA';
const OWN_NEAR = '98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de';

describe('Exolix routes beyond Monero', () => {
  it('maps the new coins with Kyro’s decimals', () => {
    expect(exolixAsset('kaspa', 'kaspa', 8)).toMatchObject({ coin: 'KAS', network: 'KAS' });
    expect(exolixAsset('algorand', 'algorand', 6)).toMatchObject({ coin: 'ALGO', network: 'ALGO' });
    expect(exolixAsset('near', 'near', 24)).toMatchObject({ coin: 'NEAR', network: 'NEAR' });
    expect(exolixAsset(42_161, NATIVE_EVM, 18)).toMatchObject({ coin: 'ETH', network: 'ARBITRUM' });
    expect(exolixAsset(137, NATIVE_EVM, 18)).toMatchObject({ coin: 'POL', network: 'MATIC' });
    expect(exolixAsset('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6)).toMatchObject({ coin: 'USDT', network: 'TRX' });
    expect(exolixAsset('dogecoin', 'dogecoin', 8)).toMatchObject({ coin: 'DOGE', network: 'DOGE' });
    expect(exolixAsset(56, NATIVE_EVM, 18)).toBeNull(); // BNB → XMR refused by Exolix
    expect(exolixAsset('near', 'near', 18)).toBeNull();
  });

  it('serves an Exolix-only chain on one side, never from an arrival-only chain', () => {
    expect(exolixRoute(1, 'kaspa')).toBe(true);
    expect(exolixRoute('tron', 'monero')).toBe(true);
    expect(exolixRoute('dogecoin', 'algorand')).toBe(true);
    expect(exolixRoute('monero', 'near')).toBe(true);
    expect(exolixRoute('kaspa', 1)).toBe(false);
    expect(exolixRoute('bitcoin', 1)).toBe(false); // 1Click / LI.FI's
    expect(exolixRoute('kaspa', 'kaspa')).toBe(false);
    expect(exolixRoute(56, 'monero')).toBe(false);
    for (const c of EXOLIX_ARRIVAL_ONLY) expect(exolixRoute(c, 'monero')).toBe(false);
  });

  it('checks recipient / deposit address shapes', () => {
    expect(validChainAddress('kaspa', OWN_KAS)).toBe(true);
    expect(validChainAddress('kaspa', OWN_KAS.replace('kaspa:', 'kaspatest:'))).toBe(false);
    expect(validChainAddress('algorand', OWN_ALGO)).toBe(true);
    expect(validChainAddress('algorand', OWN_ALGO.toLowerCase())).toBe(false);
    expect(validChainAddress('near', OWN_NEAR)).toBe(true);
    expect(validChainAddress('near', 'alice.near')).toBe(true);
    expect(validChainAddress('near', 'Alice.near')).toBe(false);
    expect(validChainAddress('tron', 'TT9j25bsbBAgxCDEXTN1cpjcD54Jz51pES')).toBe(true);
    expect(validChainAddress('dogecoin', 'DKCSjtypvD9qg3R175YdijmwvKh5FnAU14')).toBe(true);
    expect(validChainAddress('dogecoin', 'TT9j25bsbBAgxCDEXTN1cpjcD54Jz51pES')).toBe(false);
  });

  it('quotes ETH → KAS with the Kyro fee on the ETH side, and TRON → XMR to the TRON fee address', async () => {
    const seen: string[] = [];
    const fetch: NetFetch = async (r) => {
      seen.push(r.url);
      return { status: 200, body: JSON.stringify(r.url.includes('KAS') ? { fromAmount: '0.0991', toAmount: '4000', rate: 40_363, minAmount: 0.01 } : { fromAmount: 991, toAmount: 0.5, rate: 0.0005, minAmount: 100 }) };
    };
    expect(exolixFeeRecipients(KYRO_SWAP_FEE)).toMatchObject({ tron: KYRO_SWAP_FEE.recipients.tron, dogecoin: KYRO_SWAP_FEE.recipients.dogecoin });
    const p = new ExolixProvider({ fetch, fee: providerFee('exolix', KYRO_SWAP_FEE), recipients: exolixFeeRecipients(KYRO_SWAP_FEE) });
    const toKas: QuoteParams = { chain: 1, toChain: 'kaspa', recipient: OWN_KAS, sell: { address: NATIVE_EVM, symbol: 'ETH', decimals: 18 }, buy: { address: 'kaspa', symbol: 'KAS', decimals: 8 }, sellAmount: 100_000_000_000_000_000n, taker: OWN_EVM, slippageBps: 100 };
    expect(p.supports(toKas)).toBe(true);
    expect(p.supports({ ...toKas, chain: 'kaspa', toChain: 1, recipient: OWN_EVM, sell: toKas.buy, buy: toKas.sell, taker: OWN_KAS })).toBe(false);
    const q = await p.quote(toKas);
    expect(seen[0]).toContain('coinTo=KAS&networkTo=KAS');
    expect(q.buyAmount).toBe(400_000_000_000n);
    expect(q.cross).toMatchObject({ fromChain: 1, toChain: 'kaspa', recipient: OWN_KAS, bridge: 'exolix' });
    const trx: QuoteParams = { chain: 'tron', toChain: 'monero', recipient: OWN_XMR, sell: { address: 'tron', symbol: 'TRX', decimals: 6 }, buy: { address: 'monero', symbol: 'XMR', decimals: 12 }, sellAmount: 1_000_000_000n, taker: 'TT9j25bsbBAgxCDEXTN1cpjcD54Jz51pES', slippageBps: 100 };
    expect(p.supports(trx)).toBe(true);
    await p.quote(trx);
    expect(seen[1]).toContain('coinFrom=TRX&networkFrom=TRX');
    expect(seen[1]).toContain('amount=991');
  });
});
