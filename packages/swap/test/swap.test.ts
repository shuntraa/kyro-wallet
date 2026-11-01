import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import type { NetRequest, NetResponse } from '@kyro/shared';
import { zeroExData } from './calldata';
import { applySlippage, buildApproval, buildRevoke, compareQuotes, evmSwapSupported, fetchQuotes, isUnlimitedAllowance, knownSwapContract, LIFI_CHAINS, LIFI_DIAMOND, LIFI_OTHER_DEPLOYMENTS, LifiProvider, SWAP_CONTRACTS, netValueFiat, NATIVE_EVM, ZEROX_ALLOWANCE_HOLDER, ZEROX_CHAINS, ZeroExProvider, type Quote } from '../src';

const TOKEN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const SPENDER = '0x0000000000001fF3684f28c67538d4D072C22734';

describe('ERC-20 approval encoding', () => {
  it('approves the exact amount by default', () => {
    const a = buildApproval({ token: TOKEN, spender: SPENDER, amount: 800_000_000n });
    expect(a.unlimited).toBe(false);
    expect(a.amount).toBe(800_000_000n);
    expect(a.to).toBe(TOKEN);
    expect(a.data.slice(0, 10)).toBe('0x095ea7b3');
    expect(a.data).toBe(
      '0x095ea7b3' + SPENDER.slice(2).toLowerCase().padStart(64, '0') + (800_000_000n).toString(16).padStart(64, '0'),
    );
    const d = decodeFunctionData({ abi: erc20Abi, data: a.data });
    expect(d.functionName).toBe('approve');
    expect(d.args).toEqual([SPENDER, 800_000_000n]);
  });

  it('only approves 2^256-1 when unlimited is explicitly requested', () => {
    const a = buildApproval({ token: TOKEN, spender: SPENDER, amount: 1n, unlimited: true });
    expect(a.unlimited).toBe(true);
    expect(a.amount).toBe(maxUint256);
    expect(a.data.endsWith('f'.repeat(64))).toBe(true);
    expect(isUnlimitedAllowance(a.amount)).toBe(true);
    expect(isUnlimitedAllowance(800n)).toBe(false);
  });

  it('refuses a zero exact approval, revoke encodes approve(spender, 0)', () => {
    expect(() => buildApproval({ token: TOKEN, spender: SPENDER, amount: 0n })).toThrow();
    const r = buildRevoke(TOKEN, SPENDER);
    expect(r.data.endsWith('0'.repeat(64))).toBe(true);
    expect(r.amount).toBe(0n);
  });
});

const q = (over: Partial<Quote>): Quote => ({
  provider: 'zerox',
  providerName: '0x',
  buyAmount: 0n,
  minBuyAmount: 0n,
  gasFeeFiat: 0,
  providerFeeFiat: 0,
  providerFeeIncluded: true,
  kyroFeeBps: 0,
  priceImpact: null,
  allowanceTarget: null,
  tx: { kind: 'evm', chainId: 1, to: SPENDER, data: '0x', value: 0n },
  ...over,
});

describe('compareQuotes', () => {
  const buy = { address: NATIVE_EVM, symbol: 'ETH', decimals: 18, priceFiat: 2000 };
  it('sorts by net received (value − gas − non-included fee)', () => {
    const a = q({ provider: 'zerox', buyAmount: 305n * 10n ** 15n, gasFeeFiat: 1.12 }); // 610 − 1.12
    const b = q({ provider: 'jupiter', buyAmount: 306n * 10n ** 15n, gasFeeFiat: 4 }); // 612 − 4
    const c = q({ provider: 'lifi', buyAmount: 3065n * 10n ** 14n, gasFeeFiat: 1, providerFeeFiat: 2, providerFeeIncluded: false }); // 613 − 3
    const sorted = compareQuotes([a, b, c], buy).map((x) => x.provider);
    expect(sorted).toEqual(['lifi', 'zerox', 'jupiter']);
    expect(netValueFiat(c, buy)).toBeCloseTo(610, 6);
  });

  it('falls back to buyAmount when prices are unknown', () => {
    const noPrice = { address: NATIVE_EVM, symbol: 'ETH', decimals: 18 };
    const sorted = compareQuotes([q({ provider: 'zerox', buyAmount: 1n }), q({ provider: 'lifi', buyAmount: 3n }), q({ provider: 'jupiter', buyAmount: 2n })], noPrice);
    expect(sorted.map((x) => x.provider)).toEqual(['lifi', 'jupiter', 'zerox']);
  });

  it('applies slippage in basis points', () => {
    expect(applySlippage(10_000n, 50)).toBe(9_950n);
    expect(() => applySlippage(1n, -1)).toThrow();
  });
});

describe('providers', () => {
  it('report unavailable without a key and never send keys from JS', async () => {
    const seen: NetRequest[] = [];
    const fetch = async (req: NetRequest): Promise<NetResponse> => {
      seen.push(req);
      return {
        status: 200,
        body: JSON.stringify({ buyAmount: '100', minBuyAmount: '99', transaction: { to: SPENDER, data: zeroExData({ sellToken: TOKEN, sellAmount: 1_000_000n, recipient: SPENDER, buyToken: NATIVE_EVM, minAmountOut: 99n }), gas: '100000', gasPrice: '1000000000', value: '0' }, issues: { allowance: { actual: '0', spender: SPENDER } } }),
      };
    };
    const params = {
      chain: 1,
      sell: { address: TOKEN, symbol: 'USDC', decimals: 6 },
      buy: { address: NATIVE_EVM, symbol: 'ETH', decimals: 18 },
      sellAmount: 1_000_000n,
      taker: SPENDER,
      slippageBps: 50,
    };
    const off = await fetchQuotes([new ZeroExProvider({ fetch, hasKey: () => false })], params);
    expect(off.quotes).toHaveLength(0);
    expect(off.results[0]?.error).toMatch(/Clé API/);
    expect(seen).toHaveLength(0);

    const on = await fetchQuotes([new ZeroExProvider({ fetch, hasKey: () => true })], { ...params, nativePriceFiat: 2000 });
    expect(on.quotes[0]?.allowanceTarget).toBe(SPENDER);
    expect(on.quotes[0]?.gasFeeFiat).toBeCloseTo(0.2, 6);
    expect(seen[0]?.url).toContain('api.0x.org/swap/allowance-holder/quote');
    expect(seen[0]?.headers?.['0x-version']).toBe('v2');
    expect(Object.keys(seen[0]?.headers ?? {}).some((h) => /key|authorization/i.test(h))).toBe(false);
  });

  it('ask only the providers that serve the chain', () => {
    const params = (chain: number) => ({ chain, sell: { address: TOKEN, symbol: 'USDC', decimals: 6 }, buy: { address: NATIVE_EVM, symbol: 'ETH', decimals: 18 }, sellAmount: 1n, taker: SPENDER, slippageBps: 50 });
    const zerox = new ZeroExProvider({ hasKey: () => true });
    const lifi = new LifiProvider();
    expect([1, 146, 999].every((c) => zerox.supports(params(c)))).toBe(true);
    // Mantle: served by 0x, but with another AllowanceHolder than the one Kyro checks.
    expect([5_000, 25, 14, 8_217, 100, 1_329, 1_030, 11_155_111].some((c) => zerox.supports(params(c)))).toBe(false);
    // Flare, Kaia, HyperEVM: their own LI.FI Diamond (LIFI_OTHER_DEPLOYMENTS).
    expect([1, 25, 5_000, 146, 100, 1_329, 14, 8_217, 999].every((c) => lifi.supports(params(c)))).toBe(true);
    // Conflux: not served by LI.FI; Sepolia: no checked contract.
    expect([1_030, 11_155_111].some((c) => lifi.supports(params(c)))).toBe(false);
    expect(lifi.supports({ ...params(1), toChain: 1_030 })).toBe(false);
    expect(evmSwapSupported(1_030)).toBe(false);
    expect(evmSwapSupported(14)).toBe(true);
    expect(evmSwapSupported(8_217)).toBe(true);
    expect(evmSwapSupported(999)).toBe(true);
    expect(evmSwapSupported(25)).toBe(true);
  });

  it('every chain offered has the provider contract Kyro checks', () => {
    for (const c of ZEROX_CHAINS) expect(knownSwapContract('zerox', c)).toBe(ZEROX_ALLOWANCE_HOLDER);
    for (const c of LIFI_CHAINS) expect(knownSwapContract('lifi', c)).toBe(LIFI_OTHER_DEPLOYMENTS[c]?.diamond ?? LIFI_DIAMOND);
    expect(knownSwapContract('lifi', 14)).toBe('0x198FC70Dfe05E755C81e54bd67Bff3F729344B9b');
    expect(knownSwapContract('lifi', 999)).toBe('0x0a0758d937d1059c356D4714e57F5df0239bce1A');
    expect(knownSwapContract('lifi', 8_217)).toBe('0x1255d17c1BC2f764d087536410879F2d0D8772fD');
    expect(SWAP_CONTRACTS[14]?.lifi?.feeForwarder).toBe('0xA5971Bd73Dbb879aAaA6fEcB95Dc3fD50c2e3C25');
    expect(SWAP_CONTRACTS[999]?.lifi?.feeForwarder).toBe('0xba072Bf218314E51d5c3d254800d799840ae6a25');
    expect(SWAP_CONTRACTS[8_217]?.lifi?.feeForwarder).toBe('0x5161370f81b3054f43361644Ad332625f5E0804F');
    expect(knownSwapContract('zerox', 5_000)).toBeNull();
    expect(knownSwapContract('lifi', 1_030)).toBeNull();
    expect(knownSwapContract('zerox', 14)).toBeNull();
  });
});
