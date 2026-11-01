import { describe, expect, it } from 'vitest';
import { setLang, type NetRequest, type NetResponse } from '@kyro/shared';
import { createProviders, feeForQuote, feeLabel, KYRO_FEE_CURVE, PROVIDER_MAX_FEE_BPS, sellValueUsd, swapFeeBps, feeRecipientFor, fetchQuotes, JupiterProvider, KYRO_SWAP_FEE, LifiProvider, lifiFeeFor, NATIVE_EVM, providerFee, thornameFor, validFeeAddress, ZeroExProvider, type SwapFeeConfig } from '../src';
import { associatedTokenAccount } from '../src/providers/jupiter';
import { LIFI_DIAMOND } from '../src';
import { lifiData, zeroExData } from './calldata';

const TOKEN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const SPENDER = '0x0000000000001fF3684f28c67538d4D072C22734';
const FEE_EVM = '0x1111111111111111111111111111111111111111';
const FEE_SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const OTHER = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

// Flat 70 bps (one point, same rate without a price): the provider tests below keep their 70 bps fixtures.
const cfg = (over: Partial<SwapFeeConfig> = {}): SwapFeeConfig => ({
  curve: [{ usd: 1, bps: 70 }],
  unknownPriceBps: 70,
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
  it('ships the declining curve and is capped at 5 %', () => {
    expect(KYRO_SWAP_FEE.curve).toBe(KYRO_FEE_CURVE);
    expect(KYRO_SWAP_FEE.unknownPriceBps).toBe(90);
    expect(feeLabel(70)).toBe('0,7 %');
    expect(providerFee('zerox', cfg({ unknownPriceBps: 501 }))).toEqual({ kind: 'unavailable', reason: 'Frais Kyro mal configurés' });
    expect(providerFee('zerox', cfg({ curve: [{ usd: 1, bps: 501 }] })).kind).toBe('unavailable');
    expect(providerFee('zerox', cfg({ curve: [{ usd: 10, bps: 100 }, { usd: 5, bps: 200 }] })).kind).toBe('unavailable');
    expect(providerFee('zerox', cfg({ curve: [{ usd: 1, bps: 70.5 }] })).kind).toBe('unavailable');
    expect(providerFee('zerox', cfg({ curve: [] })).kind).toBe('unavailable');
  });
  it('labels and reasons follow the display language', () => {
    setLang('en');
    try {
      expect(feeLabel(70)).toBe('0.7%');
      expect(providerFee('zerox', cfg({ unknownPriceBps: 501 }))).toEqual({ kind: 'unavailable', reason: 'Kyro fees misconfigured' });
    } finally {
      setLang('fr');
    }
  });

  it('0 bps means no fee parameters at all', () => {
    for (const id of ['zerox', 'lifi', 'jupiter'] as const) expect(providerFee(id, cfg({ curve: [{ usd: 1, bps: 0 }], unknownPriceBps: 0 }))).toEqual({ kind: 'none' });
  });

  it('a provider that cannot collect the fee is left out, with the reason', () => {
    const none = cfg({ recipients: { evm: '', solana: 'not-base58-0OIl' } });
    expect(providerFee('zerox', none)).toMatchObject({ kind: 'unavailable', reason: expect.stringMatching(/EVM/) });
    expect(providerFee('lifi', none)).toMatchObject({ kind: 'unavailable', reason: expect.stringMatching(/EVM/) });
    expect(providerFee('jupiter', none)).toMatchObject({ kind: 'unavailable', reason: expect.stringMatching(/Solana/) });
    expect(providerFee('lifi', cfg())).toMatchObject({ kind: 'curve', recipient: FEE_EVM, maxBps: 4_999 });
    expect(feeForQuote(providerFee('lifi', cfg()), evmParams)).toEqual({ kind: 'fee', bps: 70, recipient: FEE_EVM });
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
  // Real ABI encodings (verify.ts decodes them): recipient = taker, minimum = 99, fee to FEE_EVM.
  const tx = { to: SPENDER, data: zeroExData({ sellToken: TOKEN, sellAmount: 1_000_000n, recipient: SPENDER, buyToken: NATIVE_EVM, minAmountOut: 99n, feeRecipient: FEE_EVM }), gas: '100000', gasPrice: '1', value: '0' };
  const txNoFee = { ...tx, data: zeroExData({ sellToken: TOKEN, sellAmount: 1_000_000n, recipient: SPENDER, buyToken: NATIVE_EVM, minAmountOut: 99n }) };

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
    const r = recorder(() => ({ buyAmount: '100', minBuyAmount: '99', transaction: txNoFee }));
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
    transactionRequest: { to: LIFI_DIAMOND, data: lifiData({ sellToken: TOKEN, buyToken: NATIVE_EVM, sellAmount: 1_000_000n, receiver: SPENDER, minAmountOut: 99n, fees: [{ recipient: receiver, amount: 7_000n }] }) },
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

describe('Kyro fee recipients on the other chains', () => {
  it('ships the owner addresses, each valid for its chain (format + checksum)', () => {
    for (const chain of ['evm', 'solana', 'bitcoin', 'litecoin', 'dogecoin', 'tron', 'xrp', 'cardano'] as const) {
      expect(feeRecipientFor(chain), chain).toBe(KYRO_SWAP_FEE.recipients[chain]);
    }
    expect(thornameFor()).toBeNull();
  });

  it('refuses malformed, wrong-network or wrong-chain addresses', () => {
    const r = KYRO_SWAP_FEE.recipients;
    const flip = (a: string) => a.slice(0, -1) + (a.endsWith('a') ? 'b' : 'a');
    for (const chain of ['bitcoin', 'litecoin', 'dogecoin', 'tron', 'xrp', 'cardano'] as const) {
      const a = r[chain] ?? '';
      expect(validFeeAddress(chain, flip(a)), `${chain} checksum`).toBe(false);
      expect(validFeeAddress(chain, ''), `${chain} empty`).toBe(false);
    }
    expect(validFeeAddress('bitcoin', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(false); // testnet
    expect(validFeeAddress('bitcoin', (r.bitcoin ?? '').toUpperCase())).toBe(false);
    expect(validFeeAddress('dogecoin', r.litecoin ?? '')).toBe(false);
    expect(validFeeAddress('litecoin', r.dogecoin ?? '')).toBe(false);
    expect(validFeeAddress('tron', r.dogecoin ?? '')).toBe(false);
    expect(validFeeAddress('xrp', r.tron ?? '')).toBe(false);
    expect(validFeeAddress('cardano', 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp')).toBe(false);
    expect(validFeeAddress('litecoin', 'ltc1qg82tdhlwmudlcnmqkd5qm5y2qy3s6tnh2gpaqp')).toBe(false); // bad checksum
  });

  it('missing recipient ⇒ the route is left out, never fee-free', () => {
    const c = cfg({ recipients: { evm: FEE_EVM, solana: '' } });
    expect(lifiFeeFor('solana', c)).toMatchObject({ kind: 'unavailable' });
    expect(feeForQuote(lifiFeeFor('solana', cfg()), evmParams)).toEqual({ kind: 'fee', bps: 70, recipient: FEE_SOL });
    expect(feeForQuote(lifiFeeFor('evm', cfg()), evmParams)).toEqual({ kind: 'fee', bps: 70, recipient: FEE_EVM });
    // LI.FI accepts only 0x… / base58 fee receivers: a Bitcoin source cannot carry the fee.
    expect(lifiFeeFor('bitcoin', cfg())).toMatchObject({ kind: 'unavailable' });
    expect(feeRecipientFor('tron', cfg())).toBeNull();
    expect(thornameFor({ ...cfg(), thorname: 'Kyro!' })).toBeNull();
    expect(thornameFor({ ...cfg(), thorname: 'kyro' })).toBe('kyro');
  });
});

describe('Kyro fee curve (USD value → bps)', () => {
  it('every point of the table', () => {
    const want: Array<[number, number]> = [[5, 500], [10, 200], [25, 180], [50, 160], [80, 140], [100, 120], [1_000, 90], [10_000, 70]];
    for (const [usd, bps] of want) expect(swapFeeBps(usd), `${usd} USD`).toBe(bps);
    expect(KYRO_FEE_CURVE.map((p) => [p.usd, p.bps])).toEqual(want);
  });
  it('flat below 5 $ and above 10 000 $', () => {
    expect(swapFeeBps(0)).toBe(500);
    expect(swapFeeBps(1)).toBe(500);
    expect(swapFeeBps(10_001)).toBe(70);
    expect(swapFeeBps(1_000_000)).toBe(70);
  });
  it('linear on log(amount) between two points, rounded to the nearest bps', () => {
    // 7 $: 500 + (200 − 500) × ln(7/5)/ln(2) = 354,4 → 354
    expect(swapFeeBps(7)).toBe(354);
    // 300 $: 120 + (90 − 120) × log10(3) = 105,7 → 106
    expect(swapFeeBps(300)).toBe(106);
    // 3 000 $: 90 + (70 − 90) × log10(3) = 80,46 → 80
    expect(swapFeeBps(3_000)).toBe(80);
    // geometric midpoints
    expect(swapFeeBps(Math.sqrt(10 * 25))).toBe(190);
    expect(swapFeeBps(Math.sqrt(100 * 1_000))).toBe(105);
    // monotonic: never more for a bigger swap
    let prev = Infinity;
    for (let usd = 1; usd <= 20_000; usd *= 1.07) {
      const b = swapFeeBps(usd);
      expect(Number.isInteger(b)).toBe(true);
      expect(b).toBeLessThanOrEqual(prev);
      prev = b;
    }
  });
  it('unknown price → 90 bps', () => {
    expect(swapFeeBps(null)).toBe(90);
    expect(swapFeeBps(undefined)).toBe(90);
    expect(swapFeeBps(Number.NaN)).toBe(90);
    expect(sellValueUsd(evmParams)).toBeNull();
    expect(feeForQuote(providerFee('zerox'), evmParams)).toMatchObject({ kind: 'fee', bps: 90 });
  });
  it('USD value = amount × price ÷ USD→currency rate', () => {
    // 1 USDC at 0,92 € with 1 $ = 0,92 € → 1 $
    expect(sellValueUsd({ ...evmParams, sell: { ...evmParams.sell, priceFiat: 0.92 }, usdToFiat: 0.92 })).toBeCloseTo(1);
    expect(sellValueUsd({ ...evmParams, sellAmount: 300_000_000n, sell: { ...evmParams.sell, priceFiat: 1 } })).toBe(300);
  });
  it('clamped to each provider maximum', () => {
    expect(PROVIDER_MAX_FEE_BPS).toEqual({ zerox: 1_000, lifi: 4_999, jupiter: 255, near: 250 });
    const tiny = { ...evmParams, sell: { ...evmParams.sell, priceFiat: 1 } }; // 1 $ → 500 bps
    expect(feeForQuote(providerFee('zerox'), tiny)).toMatchObject({ bps: 500 });
    expect(feeForQuote(providerFee('lifi'), tiny)).toMatchObject({ bps: 500 });
    expect(feeForQuote(providerFee('jupiter'), tiny)).toMatchObject({ bps: 255 });
    expect(feeForQuote(providerFee('near'), tiny)).toMatchObject({ bps: 250 });
    // 300 $ → 106 everywhere
    const mid = { ...tiny, sellAmount: 300_000_000n };
    for (const id of ['zerox', 'lifi', 'jupiter', 'near'] as const) expect(feeForQuote(providerFee(id), mid)).toMatchObject({ bps: 106 });
  });
});

describe('providers ask for and verify the curve rate (not 70 bps)', () => {
  const curveCfg = { ...cfg(), curve: KYRO_FEE_CURVE, unknownPriceBps: 90 };
  // 300 USDC at 1 $ → 106 bps; fee = 300 000 000 × 106 / 10 000 = 3 180 000
  const p300 = { ...evmParams, sellAmount: 300_000_000n, sell: { ...evmParams.sell, priceFiat: 1 } };
  const tx300 = { to: SPENDER, data: zeroExData({ sellToken: TOKEN, sellAmount: 300_000_000n, recipient: SPENDER, buyToken: NATIVE_EVM, minAmountOut: 99n, feeRecipient: FEE_EVM }), gas: '100000', gasPrice: '1', value: '0' };
  const zx = (amount: string) => new ZeroExProvider({ fetch: recorder(() => ({ buyAmount: '100', minBuyAmount: '99', transaction: tx300, fees: { integratorFee: { amount, token: TOKEN } } })).fetch, hasKey: () => true, fee: providerFee('zerox', curveCfg) });

  it('0x: swapFeeBps = 106 and the echoed fee must be exactly 1,06 %', async () => {
    const r = recorder(() => ({ buyAmount: '100', minBuyAmount: '99', transaction: tx300, fees: { integratorFee: { amount: '3180000', token: TOKEN } } }));
    const q = await new ZeroExProvider({ fetch: r.fetch, hasKey: () => true, fee: providerFee('zerox', curveCfg) }).quote(p300);
    expect(new URL(r.seen[0]!.url).searchParams.get('swapFeeBps')).toBe('106');
    expect(q.kyroFeeBps).toBe(106);
    expect(q.evmCheck?.kyroFee).toBe(3_180_000n);
    // 0,7 % (the old flat rate) is no longer what was asked: refused; so is anything above.
    await expect(zx('2100000').quote(p300)).rejects.toThrow(/différents du taux demandé/);
    await expect(zx('3180001').quote(p300)).rejects.toThrow(/supérieurs au taux/);
  });

  it('0x: unknown price → 90 bps asked and demanded', async () => {
    const r = recorder(() => ({ buyAmount: '100', minBuyAmount: '99', transaction: tx300, fees: { integratorFee: { amount: '2700000', token: TOKEN } } }));
    const q = await new ZeroExProvider({ fetch: r.fetch, hasKey: () => true, fee: providerFee('zerox', curveCfg) }).quote({ ...p300, sell: { address: TOKEN, symbol: 'USDC', decimals: 6 } });
    expect(new URL(r.seen[0]!.url).searchParams.get('swapFeeBps')).toBe('90');
    expect(q.kyroFeeBps).toBe(90);
    await expect(zx('3180000').quote({ ...p300, sell: { address: TOKEN, symbol: 'USDC', decimals: 6 } })).rejects.toThrow(/supérieurs au taux/);
  });

  it('LI.FI: distributionFees percentage = 0.0106, echo at another rate refused', async () => {
    const answer = (pct: string) => () => ({
      estimate: { toAmount: '100', toAmountMin: '99', approvalAddress: LIFI_DIAMOND, feeCosts: [{ name: 'Distributions', percentage: pct, included: true, feeSplit: { recipients: [{ walletAddress: FEE_EVM }] } }] },
      transactionRequest: { to: LIFI_DIAMOND, data: '0x', value: '0' },
    });
    const r = recorder(answer('0.0106'));
    await new LifiProvider({ fetch: r.fetch, fee: providerFee('lifi', curveCfg) }).quote(p300).catch(() => undefined);
    expect(new URL(r.seen[0]!.url).searchParams.get('distributionFees[0][percentage]')).toBe('0.0106');
    await expect(new LifiProvider({ fetch: recorder(answer('0.0070')).fetch, fee: providerFee('lifi', curveCfg) }).quote(p300)).rejects.toThrow(/frais Kyro non appliqués/);
  });

  it('Jupiter: platformFeeBps = the curve rate (clamped to 255), echo must match', async () => {
    const solP = (usd: number) => ({ chain: 'solana' as const, sell: { address: WSOL, symbol: 'SOL', decimals: 9, priceFiat: usd }, buy: { address: USDC_SOL, symbol: 'USDC', decimals: 6 }, sellAmount: 1_000_000_000n, taker: FEE_SOL, slippageBps: 50 });
    const jup = (feeBps: number) => recorder((req) => (req.method === 'POST' ? { swapTransaction: 'AAAA' } : { outAmount: '100', otherAmountThreshold: '99', platformFee: { amount: '1', feeBps } }));
    const provider = (fetch: ReturnType<typeof recorder>['fetch']) => new JupiterProvider({ fetch, fee: providerFee('jupiter', curveCfg), feeMints: [USDC_SOL] });
    const r = jup(106);
    expect((await provider(r.fetch).quote(solP(300))).kyroFeeBps).toBe(106);
    expect(new URL(r.seen[0]!.url).searchParams.get('platformFeeBps')).toBe('106');
    const tiny = jup(255);
    expect((await provider(tiny.fetch).quote(solP(2))).kyroFeeBps).toBe(255);
    expect(new URL(tiny.seen[0]!.url).searchParams.get('platformFeeBps')).toBe('255');
    await expect(provider(jup(70).fetch).quote(solP(300))).rejects.toThrow(/frais Kyro non appliqués/);
  });
});
