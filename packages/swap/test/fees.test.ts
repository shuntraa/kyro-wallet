import { describe, expect, it } from 'vitest';
import type { NetRequest, NetResponse } from '@kyro/shared';
import { createProviders, feeLabel, fetchQuotes, JupiterProvider, KYRO_SWAP_FEE, LifiProvider, NATIVE_EVM, providerFee, ZeroExProvider, type SwapFeeConfig } from '../src';
import { associatedTokenAccount } from '../src/providers/jupiter';

const TOKEN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const SPENDER = '0x0000000000001fF3684f28c67538d4D072C22734';
const FEE_EVM = '0x1111111111111111111111111111111111111111';
const FEE_SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const OTHER = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

const cfg = (over: Partial<SwapFeeConfig> = {}): SwapFeeConfig => ({
  bps: 70,
  recipients: { evm: FEE_EVM, solana: FEE_SOL },
  solanaFeeMints: [WSOL, USDC_SOL],
  ...over,
});

const sentBody = (req: NetRequest | undefined) => JSON.parse(String(req?.body ?? '{}')) as { feeAccount?: string };

const recorder = (body: (req: NetRequest) => unknown) => {
  const seen: NetRequest[] = [];
  const fetch = async (req: NetRequest): Promise<NetResponse> => {
    seen.push(req);
    return { status: 200, body: JSON.stringify(body(req)) };
  };
  return { seen, fetch };
};

const evmParams = {
  chain: 1,
  sell: { address: TOKEN, symbol: 'USDC', decimals: 6 },
  buy: { address: NATIVE_EVM, symbol: 'ETH', decimals: 18 },
  sellAmount: 1_000_000n,
  taker: SPENDER,
  slippageBps: 50,
};

describe('Kyro fee config', () => {
  it('ships at 70 bps and is capped at 1 %', () => {
    expect(KYRO_SWAP_FEE.bps).toBe(70);
    expect(feeLabel(70)).toBe('0,7 %');
    expect(providerFee('zerox', cfg({ bps: 101 }))).toEqual({ kind: 'unavailable', reason: 'Frais Kyro mal configurés' });
  });

  it('0 bps means no fee parameters at all', () => {
    for (const id of ['zerox', 'lifi', 'jupiter'] as const) expect(providerFee(id, cfg({ bps: 0 }))).toEqual({ kind: 'none' });
  });

  it('a provider that cannot collect the fee is left out, with the reason', () => {
    const none = cfg({ recipients: { evm: '', solana: 'not-base58-0OIl' } });
    expect(providerFee('zerox', none)).toMatchObject({ kind: 'unavailable', reason: expect.stringMatching(/EVM/) });
    expect(providerFee('lifi', none)).toMatchObject({ kind: 'unavailable', reason: expect.stringMatching(/EVM/) });
    expect(providerFee('jupiter', none)).toMatchObject({ kind: 'unavailable', reason: expect.stringMatching(/Solana/) });
    expect(providerFee('lifi', cfg())).toEqual({ kind: 'fee', bps: 70, recipient: FEE_EVM });
  });

  it('without recipients, no quote is ever made fee-free', async () => {
    const r = recorder(() => ({}));
    const providers = createProviders({ fetch: r.fetch, hasZeroxKey: () => true, fees: cfg({ recipients: { evm: '', solana: '' } }) });
    const out = await fetchQuotes(providers, evmParams);
    expect(out.quotes).toHaveLength(0);
    expect(out.results.map((x) => x.error)).toEqual([expect.stringMatching(/EVM/), expect.stringMatching(/EVM/)]);
    expect(r.seen).toHaveLength(0);
  });
});

describe('Kyro fee parameters per provider', () => {
  const tx = { to: SPENDER, data: '0x12', gas: '100000', gasPrice: '1', value: '0' };

  it('0x: swapFeeRecipient / swapFeeBps / swapFeeToken = sell token', async () => {
    const r = recorder(() => ({ buyAmount: '100', minBuyAmount: '99', transaction: tx, fees: { integratorFee: { amount: '7000', token: TOKEN } } }));
    const quote = await new ZeroExProvider({ fetch: r.fetch, hasKey: () => true, fee: providerFee('zerox', cfg()) }).quote(evmParams);
    const url = new URL(r.seen[0]!.url);
    expect(url.searchParams.get('swapFeeRecipient')).toBe(FEE_EVM);
    expect(url.searchParams.get('swapFeeBps')).toBe('70');
    expect(url.searchParams.get('swapFeeToken')).toBe(TOKEN);
    expect(quote.kyroFeeBps).toBe(70);
  });

  it('0x: a quote that does not echo fees.integratorFee is refused', async () => {
    const r = recorder(() => ({ buyAmount: '100', minBuyAmount: '99', transaction: tx, fees: { integratorFee: null } }));
    await expect(new ZeroExProvider({ fetch: r.fetch, hasKey: () => true, fee: providerFee('zerox', cfg()) }).quote(evmParams)).rejects.toThrow(/frais Kyro non appliqués/);
  });

  it('0x: no fee parameter when the fee is off', async () => {
    const r = recorder(() => ({ buyAmount: '100', minBuyAmount: '99', transaction: tx }));
    const quote = await new ZeroExProvider({ fetch: r.fetch, hasKey: () => true, fee: { kind: 'none' } }).quote(evmParams);
    expect(new URL(r.seen[0]!.url).searchParams.has('swapFeeBps')).toBe(false);
    expect(quote.kyroFeeBps).toBe(0);
  });

  // Shape of a real li.quest answer to distributionFees (observed live on 31/10/2026, Arbitrum USDC → ETH).
  const lifiAnswer = (receiver: string, percentage: string) => ({
    estimate: {
      toAmount: '100',
      toAmountMin: '99',
      feeCosts: [
        { name: 'LIFI Fixed Fee', percentage: '0.0025', included: true, feeSplit: { lifiFee: '25000', integratorFee: '0', recipients: [{ name: 'lifi', type: 'FIXED', fee: '25000' }] } },
        { name: 'Distributions', percentage, included: true, feeSplit: { integratorFee: '0', lifiFee: '0', recipients: [{ name: receiver, fee: '70000', type: 'DISTRIBUTION', walletAddress: receiver }] } },
      ],
    },
    transactionRequest: { to: SPENDER, data: '0x12' },
  });

  it('LI.FI: distributionFees[0][receiver] + [percentage] as a FRACTION (0.007), no integrator', async () => {
    const r = recorder(() => lifiAnswer(FEE_EVM, '0.0070'));
    const quote = await new LifiProvider({ fetch: r.fetch, fee: providerFee('lifi', cfg()) }).quote(evmParams);
    const url = new URL(r.seen[0]!.url);
    expect(url.searchParams.get('distributionFees[0][receiver]')).toBe(FEE_EVM);
    expect(url.searchParams.get('distributionFees[0][percentage]')).toBe('0.007');
    expect(url.searchParams.has('integrator')).toBe(false);
    expect(quote.kyroFeeBps).toBe(70);
  });

  it('LI.FI: refuses a quote whose distribution goes elsewhere or at another rate', async () => {
    const other = '0x2222222222222222222222222222222222222222';
    await expect(new LifiProvider({ fetch: recorder(() => lifiAnswer(other, '0.0070')).fetch, fee: providerFee('lifi', cfg()) }).quote(evmParams)).rejects.toThrow(/frais Kyro non appliqués/);
    await expect(new LifiProvider({ fetch: recorder(() => lifiAnswer(FEE_EVM, '0.0050')).fetch, fee: providerFee('lifi', cfg()) }).quote(evmParams)).rejects.toThrow(/frais Kyro non appliqués/);
  });

  describe('Jupiter', () => {
    const solParams = (sell: string, buy: string) => ({
      chain: 'solana' as const,
      sell: { address: sell, symbol: 'A', decimals: 9 },
      buy: { address: buy, symbol: 'B', decimals: 6 },
      sellAmount: 1_000_000_000n,
      taker: FEE_SOL,
      slippageBps: 50,
    });
    const jup = (platformFee: unknown) => recorder((req) => (req.method === 'POST' ? { swapTransaction: 'AAAA' } : { outAmount: '100', otherAmountThreshold: '99', platformFee }));
    const provider = (fetch: ReturnType<typeof recorder>['fetch']) => new JupiterProvider({ fetch, fee: providerFee('jupiter', cfg()), feeMints: [WSOL, USDC_SOL] });

    it('platformFeeBps on /quote; feeAccount = fee wallet ATA of the OUTPUT mint', async () => {
      const r = jup({ amount: '1', feeBps: 70 });
      const quote = await provider(r.fetch).quote(solParams(WSOL, USDC_SOL));
      expect(new URL(r.seen[0]!.url).searchParams.get('platformFeeBps')).toBe('70');
      if (quote.tx.kind !== 'solana') throw new Error('expected a Solana swap');
      await quote.tx.build();
      const body = sentBody(r.seen[1]);
      expect(body.feeAccount).toBe(await associatedTokenAccount(FEE_SOL, USDC_SOL));
      expect(body.feeAccount).not.toBe(await associatedTokenAccount(FEE_SOL, WSOL));
      expect(quote.kyroFeeBps).toBe(70);
    });

    it('falls back to the INPUT mint when only it is a fee mint', async () => {
      const r = jup({ amount: '1', feeBps: 70 });
      const quote = await provider(r.fetch).quote(solParams(WSOL, BONK));
      if (quote.tx.kind !== 'solana') throw new Error('expected a Solana swap');
      await quote.tx.build();
      expect(sentBody(r.seen[1]).feeAccount).toBe(await associatedTokenAccount(FEE_SOL, WSOL));
    });

    it('refuses a pair without any fee mint, and a quote that does not echo the fee', async () => {
      await expect(provider(jup({ feeBps: 70 }).fetch).quote(solParams(BONK, OTHER))).rejects.toThrow(/SOL ou USDC/);
    });

    it('shipped config: USDC only, a pair without USDC gets no quote', async () => {
      expect(KYRO_SWAP_FEE.solanaFeeMints).toEqual([USDC_SOL]);
      const usdcOnly = new JupiterProvider({ fetch: jup({ feeBps: 70 }).fetch, fee: providerFee('jupiter', cfg()), feeMints: KYRO_SWAP_FEE.solanaFeeMints });
      await expect(usdcOnly.quote(solParams(WSOL, BONK))).rejects.toThrow(/seulement si USDC est dans la paire/);
      const r = jup({ amount: '1', feeBps: 70 });
      const quote = await new JupiterProvider({ fetch: r.fetch, fee: providerFee('jupiter', cfg()), feeMints: KYRO_SWAP_FEE.solanaFeeMints }).quote(solParams(USDC_SOL, WSOL));
      if (quote.tx.kind !== 'solana') throw new Error('expected a Solana swap');
      await quote.tx.build();
      expect(sentBody(r.seen[1]).feeAccount).toBe(await associatedTokenAccount(FEE_SOL, USDC_SOL));
      await expect(provider(jup(null).fetch).quote(solParams(WSOL, USDC_SOL))).rejects.toThrow(/frais Kyro non appliqués/);
    });
  });
});
