// EVM swap answers: what Kyro decodes and refuses before showing (and again before signing).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { setBackend, type NetRequest, type NetResponse } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { compareFreshQuote, createProviders, fetchQuotes, isCurrentZeroExSettler, LIFI_DIAMOND, LifiProvider, NATIVE_EVM, providerFee, verifyEvmSwap, ZEROX_ALLOWANCE_HOLDER, ZeroExProvider, type EvmSwapCheckInput } from '../src';
import { lifiData, SETTLER, zeroExData } from './calldata';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TAKER = '0x4F2A9c83b1E07D6a55C0E91B3D7f28aE6c19d7b2';
const FEE = '0x86cD9af8067fF5e0001c709a550cD62b5e968B44';
const THIEF = '0xbad0000000000000000000000000000000000bad';
const fee = { kind: 'fee' as const, bps: 70, recipient: FEE };

const sell = { address: USDC, symbol: 'USDC', decimals: 6 };
const buy = { address: NATIVE_EVM, symbol: 'ETH', decimals: 18 };
const sellAmount = 1_000_000_000n; // 1 000 USDC
const buyAmount = 300_000_000_000_000_000n;
const min = (buyAmount * 9_950n) / 10_000n;

const zerox = (over: Partial<EvmSwapCheckInput> = {}, data: Partial<Parameters<typeof zeroExData>[0]> = {}): EvmSwapCheckInput => ({
  provider: 'zerox',
  chainId: 1,
  sell,
  buy,
  sellAmount,
  taker: TAKER,
  slippageBps: 50,
  buyAmount,
  tx: { to: ZEROX_ALLOWANCE_HOLDER, data: zeroExData({ sellToken: USDC, sellAmount, recipient: TAKER, buyToken: NATIVE_EVM, minAmountOut: min, feeRecipient: FEE, ...data }), value: 0n },
  allowanceTarget: ZEROX_ALLOWANCE_HOLDER,
  fee,
  integratorFee: { amount: 7_000_000n, token: USDC },
  ...over,
});

const lifi = (over: Partial<EvmSwapCheckInput> = {}, data: Partial<Parameters<typeof lifiData>[0]> = {}): EvmSwapCheckInput => ({
  provider: 'lifi',
  chainId: 42161,
  sell,
  buy,
  sellAmount,
  taker: TAKER,
  slippageBps: 50,
  buyAmount,
  tx: { to: LIFI_DIAMOND, data: lifiData({ sellToken: USDC, buyToken: NATIVE_EVM, sellAmount, receiver: TAKER, minAmountOut: min, fees: [{ recipient: '0xc06ebbefd94032b85424d51906e2a335efae264b', amount: 2_500_000n }, { recipient: FEE, amount: 7_000_000n }], ...data }), value: 0n },
  allowanceTarget: LIFI_DIAMOND,
  fee,
  ...over,
});

describe('0x: AllowanceHolder.exec → Settler.execute', () => {
  it('accepts a well-formed answer and returns what the contract enforces', () => {
    const c = verifyEvmSwap(zerox());
    expect(c).toMatchObject({ contract: ZEROX_ALLOWANCE_HOLDER, recipient: TAKER, minBuyAmount: min, settler: SETTLER, kyroFee: 7_000_000n });
  });

  it('refuses another entry contract or spender, and testnets (no known contract)', () => {
    expect(() => verifyEvmSwap(zerox({ tx: { ...zerox().tx, to: THIEF } }))).toThrow(/contrat inattendu/);
    expect(() => verifyEvmSwap(zerox({ allowanceTarget: THIEF }))).toThrow(/autorisation demandée pour/);
    expect(() => verifyEvmSwap(zerox({ allowanceTarget: SETTLER }))).toThrow(/autorisation/);
    expect(() => verifyEvmSwap(zerox({ chainId: 11155111 }))).toThrow(/aucun contrat 0x connu/);
  });

  it('checks the native value: 0 for a token sale, exactly the amount for a native sale', () => {
    expect(() => verifyEvmSwap(zerox({ tx: { ...zerox().tx, value: 1n } }))).toThrow(/valeur native/);
    const native = { sell: { address: NATIVE_EVM, symbol: 'ETH', decimals: 18 }, buy: sell, sellAmount: 10n ** 18n, buyAmount: 3_000_000_000n, allowanceTarget: null, integratorFee: { amount: 7n * 10n ** 15n, token: NATIVE_EVM } };
    const data = zeroExData({ sellToken: NATIVE_EVM, sellAmount: 10n ** 18n, recipient: TAKER, buyToken: USDC, minAmountOut: 2_985_000_000n, feeRecipient: FEE });
    expect(verifyEvmSwap(zerox({ ...native, tx: { to: ZEROX_ALLOWANCE_HOLDER, data, value: 10n ** 18n } })).minBuyAmount).toBe(2_985_000_000n);
    expect(() => verifyEvmSwap(zerox({ ...native, tx: { to: ZEROX_ALLOWANCE_HOLDER, data, value: 2n * 10n ** 18n } }))).toThrow(/valeur envoyée/);
  });

  it('refuses a recipient other than the taker, a lower minimum, another token or amount', () => {
    expect(() => verifyEvmSwap(zerox({}, { recipient: THIEF }))).toThrow(/destinataire/);
    expect(() => verifyEvmSwap(zerox({}, { minAmountOut: min / 2n }))).toThrow(/minimum garanti/);
    expect(() => verifyEvmSwap(zerox({}, { minAmountOut: 0n }))).toThrow(/minimum garanti/);
    expect(() => verifyEvmSwap(zerox({}, { buyToken: USDC }))).toThrow(/token reçu/);
    expect(() => verifyEvmSwap(zerox({}, { sellAmount: sellAmount * 2n }))).toThrow(/montant autorisé/);
    expect(() => verifyEvmSwap(zerox({}, { operator: THIEF }))).toThrow(/opérateur/);
    expect(() => verifyEvmSwap(zerox({ tx: { ...zerox().tx, data: '0x12' as Hex } }))).toThrow(/calldata illisible/);
  });

  it('checks the Kyro fee: present, sell token, at most the configured rate, recipient in the transaction', () => {
    expect(() => verifyEvmSwap(zerox({ integratorFee: null }))).toThrow(/frais Kyro non appliqués/);
    expect(() => verifyEvmSwap(zerox({ integratorFee: { amount: 7_000_001n, token: USDC } }))).toThrow(/supérieurs au taux/);
    expect(() => verifyEvmSwap(zerox({ integratorFee: { amount: 7_000_000n, token: NATIVE_EVM } }))).toThrow(/autre token/);
    expect(() => verifyEvmSwap(zerox({}, { feeRecipient: THIEF }))).toThrow(/bénéficiaire des frais/);
    // Fee off: no fee requirement at all.
    expect(verifyEvmSwap(zerox({ fee: { kind: 'none' }, integratorFee: null }, { feeRecipient: undefined })).kyroFee).toBeUndefined();
  });

  it('the Settler must be the registry’s current or previous one', async () => {
    expect(await isCurrentZeroExSettler(SETTLER, async (fn) => (fn === 'ownerOf' ? SETTLER : THIEF))).toBe(true);
    expect(await isCurrentZeroExSettler(SETTLER, async (fn) => (fn === 'ownerOf' ? THIEF : SETTLER.toLowerCase()))).toBe(true);
    expect(await isCurrentZeroExSettler(THIEF, async () => SETTLER)).toBe(false);
  });
});

describe('LI.FI: GenericSwapFacetV3 + FeeForwarder', () => {
  it('accepts a well-formed answer', () => {
    expect(verifyEvmSwap(lifi())).toMatchObject({ contract: LIFI_DIAMOND, recipient: TAKER, minBuyAmount: min, kyroFee: 7_000_000n });
  });

  it('refuses another contract, receiver, minimum, or steps that do not match the sale', () => {
    expect(() => verifyEvmSwap(lifi({ tx: { ...lifi().tx, to: THIEF } }))).toThrow(/contrat inattendu/);
    expect(() => verifyEvmSwap(lifi({ allowanceTarget: THIEF }))).toThrow(/autorisation/);
    expect(() => verifyEvmSwap(lifi({}, { receiver: THIEF }))).toThrow(/destinataire/);
    expect(() => verifyEvmSwap(lifi({}, { minAmountOut: min - min / 100n }))).toThrow(/minimum garanti/);
    expect(() => verifyEvmSwap(lifi({}, { sellAmount: sellAmount + 1n }))).toThrow(/première étape/);
    expect(() => verifyEvmSwap(lifi({}, { buyToken: USDC }))).toThrow(/dernière étape/);
    expect(() => verifyEvmSwap(lifi({ tx: { ...lifi().tx, data: '0x4630a0d8' as Hex } }))).toThrow(/fonction du Diamond/);
  });

  it('checks the fee step: Kyro recipient, rate, total', () => {
    expect(() => verifyEvmSwap(lifi({}, { fees: [{ recipient: THIEF, amount: 7_000_000n }] }))).toThrow(/frais Kyro absents/);
    expect(() => verifyEvmSwap(lifi({}, { fees: [{ recipient: FEE, amount: 8_000_000n }] }))).toThrow(/supérieurs au taux/);
    expect(() => verifyEvmSwap(lifi({}, { fees: [{ recipient: FEE, amount: 7_000_000n }, { recipient: THIEF, amount: 20_000_000n }] }))).toThrow(/au total/);
    expect(() => verifyEvmSwap(lifi({}, { fees: [] }))).toThrow(/frais Kyro absents/);
  });

  // Live li.quest answers (01/11/2026), unmodified calldata: the decoder must accept the real thing.
  // Flare and HyperEVM: their own Diamond and FeeForwarder (LIFI_OTHER_DEPLOYMENTS).
  for (const name of ['lifi-arbitrum-usdc-eth', 'lifi-base-eth-usdc', 'lifi-flare-flr-usdt0', 'lifi-flare-usdt0-flr', 'lifi-hyperevm-hype-usdt0', 'lifi-hyperevm-usdt0-hype']) {
    it(`real answer: ${name}`, () => {
      const j = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as {
        action: { fromChainId: number; fromAmount: string; fromToken: string; toToken: string; fromAddress: string; slippage: number };
        estimate: { toAmount: string; toAmountMin: string; approvalAddress: string };
        transactionRequest: { to: string; data: Hex; value: string };
      };
      const nativeSell = j.action.fromToken === '0x0000000000000000000000000000000000000000';
      const input: EvmSwapCheckInput = {
        provider: 'lifi',
        chainId: j.action.fromChainId,
        sell: { address: nativeSell ? NATIVE_EVM : j.action.fromToken, symbol: 'A', decimals: 6 },
        buy: { address: j.action.toToken === '0x0000000000000000000000000000000000000000' ? NATIVE_EVM : j.action.toToken, symbol: 'B', decimals: 6 },
        sellAmount: BigInt(j.action.fromAmount),
        taker: j.action.fromAddress,
        slippageBps: Math.round(j.action.slippage * 10_000),
        buyAmount: BigInt(j.estimate.toAmount),
        tx: { to: j.transactionRequest.to, data: j.transactionRequest.data, value: BigInt(j.transactionRequest.value) },
        allowanceTarget: nativeSell ? null : j.estimate.approvalAddress,
        fee,
      };
      const c = verifyEvmSwap(input);
      expect(c.contract.toLowerCase()).toBe(j.transactionRequest.to.toLowerCase());
      expect(c.minBuyAmount).toBe(BigInt(j.estimate.toAmountMin));
      expect(c.kyroFee).toBe((BigInt(j.action.fromAmount) * 70n) / 10_000n);
      // The same calldata for another taker, or with a tighter slippage than it encodes: refused.
      expect(() => verifyEvmSwap({ ...input, taker: TAKER })).toThrow(/destinataire/);
      expect(() => verifyEvmSwap({ ...input, slippageBps: 10 })).toThrow(/minimum garanti/);
      expect(() => verifyEvmSwap({ ...input, sellAmount: input.sellAmount - 1n, tx: { ...input.tx, value: nativeSell ? input.sellAmount - 1n : 0n } })).toThrow(/première étape/);
      // The same answer on a chain whose Diamond is another address: refused.
      const other = input.chainId === 1 || input.chainId === 42_161 || input.chainId === 8_453 ? 14 : 42_161;
      expect(() => verifyEvmSwap({ ...input, chainId: other })).toThrow();
    });
  }
});

describe('providers refuse an answer that fails the checks (the quote is dropped)', () => {
  const answer = (body: unknown) => async (_req: NetRequest): Promise<NetResponse> => ({ status: 200, body: JSON.stringify(body) });
  const params = { chain: 1, sell, buy, sellAmount, taker: TAKER, slippageBps: 50 };

  it('0x: the shown minimum is the one decoded from the calldata', async () => {
    const tx = { to: ZEROX_ALLOWANCE_HOLDER, data: zeroExData({ sellToken: USDC, sellAmount, recipient: TAKER, buyToken: NATIVE_EVM, minAmountOut: min, feeRecipient: FEE }), gas: '100000', gasPrice: '1', value: '0' };
    const ok = await new ZeroExProvider({ fetch: answer({ buyAmount: buyAmount.toString(), minBuyAmount: (min + 5n).toString(), transaction: tx, issues: { allowance: { spender: ZEROX_ALLOWANCE_HOLDER } }, fees: { integratorFee: { amount: '7000000', token: USDC } } }), hasKey: () => true, fee: providerFee('zerox', { curve: [{ usd: 1, bps: 70 }], unknownPriceBps: 70, recipients: { evm: FEE, solana: '' }, solanaFeeMints: [] }) }).quote(params);
    expect(ok.minBuyAmount).toBe(min);
    expect(ok.evmCheck?.settler).toBe(SETTLER);
    const evil = { ...tx, data: zeroExData({ sellToken: USDC, sellAmount, recipient: THIEF, buyToken: NATIVE_EVM, minAmountOut: min, feeRecipient: FEE }) };
    await expect(new ZeroExProvider({ fetch: answer({ buyAmount: buyAmount.toString(), minBuyAmount: min.toString(), transaction: evil, issues: { allowance: { spender: ZEROX_ALLOWANCE_HOLDER } }, fees: { integratorFee: { amount: '7000000', token: USDC } } }), hasKey: () => true, fee }).quote(params)).rejects.toThrow(/destinataire/);
  });

  it('LI.FI: a spender that is not the Diamond is refused', async () => {
    const body = {
      estimate: { toAmount: buyAmount.toString(), toAmountMin: min.toString(), approvalAddress: THIEF, feeCosts: [{ name: 'Distributions', percentage: '0.0070', included: true, feeSplit: { recipients: [{ walletAddress: FEE }] } }] },
      transactionRequest: { to: LIFI_DIAMOND, data: lifi().tx.data, value: '0x0' },
    };
    await expect(new LifiProvider({ fetch: answer(body), fee }).quote({ ...params, chain: 42161 })).rejects.toThrow(/autorisation demandée/);
    const good = await new LifiProvider({ fetch: answer({ ...body, estimate: { ...body.estimate, approvalAddress: LIFI_DIAMOND } }), fee }).quote({ ...params, chain: 42161 });
    expect(good.allowanceTarget).toBe(LIFI_DIAMOND);
  });
});

describe('demo mode answers carry real calldata (mock-net.ts)', () => {
  it('0x and LI.FI demo quotes pass the same checks, both directions', async () => {
    const backend = createMockBackend({ network: 'mainnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } });
    setBackend(backend.invoke);
    const taker = getAddress(backend.chain.accounts.evm.address);
    const providers = createProviders({ hasZeroxKey: () => true });
    for (const [s, b, amount] of [[sell, buy, 100_000_000n], [buy, sell, 10n ** 17n]] as const) {
      const out = await fetchQuotes(providers, { chain: 1, sell: s, buy: b, sellAmount: amount, taker, slippageBps: 50 });
      expect(out.results.filter((r) => r.error)).toEqual([]);
      expect(out.quotes.map((x) => x.provider).sort()).toEqual(['lifi', 'zerox']);
      for (const x of out.quotes) expect(x.evmCheck?.recipient).toBe(taker);
    }
  });
});

describe('fresh quote before signing', () => {
  const q = (to: string, spender: string | null, min: bigint) => ({ allowanceTarget: spender, minBuyAmount: min, tx: { kind: 'evm' as const, to } });
  it('refuses another contract or spender, flags a lower minimum', () => {
    expect(compareFreshQuote(q(LIFI_DIAMOND, LIFI_DIAMOND, 100n), q(THIEF, LIFI_DIAMOND, 100n))).toMatchObject({ ok: false });
    expect(compareFreshQuote(q(LIFI_DIAMOND, LIFI_DIAMOND, 100n), q(LIFI_DIAMOND, THIEF, 100n))).toMatchObject({ ok: false });
    expect(compareFreshQuote(q(LIFI_DIAMOND, LIFI_DIAMOND, 100n), q(LIFI_DIAMOND.toLowerCase(), LIFI_DIAMOND, 100n))).toEqual({ ok: true, degraded: false });
    expect(compareFreshQuote(q(LIFI_DIAMOND, null, 100n), q(LIFI_DIAMOND, null, 99n))).toEqual({ ok: true, degraded: true });
  });
});
