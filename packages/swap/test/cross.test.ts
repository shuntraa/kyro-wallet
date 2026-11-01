// Cross-chain swaps (LI.FI through NEAR Intents), against REAL li.quest answers and the matching
// 1Click status of their deposit address (read-only, recorded 01/11/2026, never signed).
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData, getAddress, type Hex } from 'viem';
import { getBase64Decoder, getBase64Encoder, getTransactionDecoder } from '@solana/kit';
import { setBackend, type NetRequest, type NetResponse, type SolInstruction, type SolTxSummary } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import {
  checkNearDeposit,
  createProviders,
  fetchQuotes,
  KYRO_SWAP_FEE,
  LIFI_DIAMOND,
  LIFI_NEAR_ABI,
  LIFI_SOLANA_FEE_WALLET,
  LifiProvider,
  lifiFeeFor,
  lifiTransferStatus,
  NATIVE_EVM,
  nonEvmReceiverWord,
  providerFee,
  solWireCostLamports,
  verifyEvmSwap,
  verifyLifiSolanaSource,
  WSOL_MINT,
  type EvmSwapCheckInput,
  type LifiSolanaCheckInput,
  type OneClickStatus,
  type OneClickToken,
  type QuoteParams,
} from '../src';
import { FLAT70 } from './flat-fee';
import { staticKeys, summaryOf } from './solsummary';

interface Fixture {
  request: Record<string, string | number>;
  tool: string;
  estimate: { toAmount: string; toAmountMin: string; feeCosts: unknown[] };
  transactionRequest: { to?: string; data: string; value?: string };
  nearIntentsStatus: OneClickStatus;
}
const load = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/cross/lifi-${n}.json`, import.meta.url), 'utf8')) as Fixture;
const TOKENS = (JSON.parse(readFileSync(new URL('./fixtures/cross/1click-tokens.json', import.meta.url), 'utf8')) as { tokens: OneClickToken[] }).tokens;

const EVM_TAKER = '0x4F2A9c83b1E07D6a55C0E91B3D7f28aE6c19d7b2';
const SOL_TAKER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const BTC_TAKER = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const FEE_EVM = KYRO_SWAP_FEE.recipients.evm;
const FEE_SOL = KYRO_SWAP_FEE.recipients.solana;
const THIEF_EVM = '0xbad0000000000000000000000000000000000bad';
const THIEF_SOL = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NOW = Date.parse('2026-11-01T01:00:00Z');
const fee = { kind: 'fee' as const, bps: 70, recipient: FEE_EVM };

/** Serves the recorded li.quest answer and the 1Click status of its deposit address. */
function server(f: Fixture, over: { status?: OneClickStatus; lifi?: unknown } = {}) {
  const seen: string[] = [];
  const fetch = async (req: NetRequest): Promise<NetResponse> => {
    seen.push(req.url);
    const u = new URL(req.url);
    if (u.host === 'li.quest') return { status: 200, body: JSON.stringify(over.lifi ?? f) };
    if (u.pathname === '/v0/tokens') return { status: 200, body: JSON.stringify(TOKENS) };
    if (u.pathname === '/v0/status') return { status: 200, body: JSON.stringify(over.status ?? f.nearIntentsStatus) };
    return { status: 404, body: '{}' };
  };
  return { seen, fetch };
}

const evmInput = (f: Fixture, o: { chainId: number; sell: string; sellDecimals: number; buy: string; buyDecimals: number; toChain: 'solana' | 'bitcoin' | number; recipient: string }, over: Partial<EvmSwapCheckInput> = {}): EvmSwapCheckInput => ({
  provider: 'lifi',
  chainId: o.chainId,
  sell: { address: o.sell, symbol: 'S', decimals: o.sellDecimals },
  buy: { address: o.buy, symbol: 'B', decimals: o.buyDecimals },
  sellAmount: BigInt(f.request.fromAmount ?? 0),
  taker: EVM_TAKER,
  slippageBps: 50,
  buyAmount: BigInt(f.estimate.toAmount),
  tx: { to: f.transactionRequest.to ?? '', data: f.transactionRequest.data as Hex, value: BigInt(f.transactionRequest.value ?? 0) },
  allowanceTarget: o.sell === NATIVE_EVM ? null : LIFI_DIAMOND,
  fee,
  cross: { toChain: o.toChain, recipient: o.recipient },
  ...over,
});

/** Re-encodes the real calldata with one field changed. */
function mutate(data: string, edit: (bd: Record<string, unknown>, nd: Record<string, unknown>, steps: Array<Record<string, unknown>>) => void): Hex {
  const d = decodeFunctionData({ abi: LIFI_NEAR_ABI, data: data as Hex });
  if (d.functionName !== 'swapAndStartBridgeTokensViaNEARIntents') throw new Error('fixture: swapAndStart expected');
  const bd = { ...(d.args[0] as Record<string, unknown>) };
  const steps = (d.args[1] as ReadonlyArray<Record<string, unknown>>).map((s) => ({ ...s }));
  const nd = { ...(d.args[2] as Record<string, unknown>) };
  edit(bd, nd, steps);
  return encodeFunctionData({ abi: LIFI_NEAR_ABI, functionName: 'swapAndStartBridgeTokensViaNEARIntents', args: [bd, steps, nd] as never });
}

const ARB_SOL = { chainId: 42161, sell: ARB_USDC, sellDecimals: 6, buy: WSOL_MINT, buyDecimals: 9, toChain: 'solana' as const, recipient: SOL_TAKER };

describe('EVM → Solana (Arbitrum USDC → SOL, real NEARIntentsFacet calldata)', () => {
  const f = load('evm-sol');

  it('accepts the live answer: receiver = our Solana key, refund = us, minimum, Kyro fee 0,7 % in USDC to the EVM fee wallet', () => {
    const c = verifyEvmSwap(evmInput(f, ARB_SOL));
    expect(c.recipient).toBe(SOL_TAKER);
    expect(c.minBuyAmount).toBe(BigInt(f.estimate.toAmountMin));
    expect(c.kyroFee).toBe(140_000n); // 0,7 % of 20 USDC
    expect(c.bridge).toMatchObject({ tool: 'near', depositAddress: getAddress('0x0a70e127a87bf8454dfa839d4f9af02610adc9ba') });
    expect(nonEvmReceiverWord('solana', SOL_TAKER)).toBe('0x7e8c088760bfde1dddcf32c17f209b8242ee52aaf131facd88d0ea2c6d0b06f2');
  });

  it('refuses another receiver, refund address, chain, token, a lower minimum or a missing destination check', () => {
    expect(() => verifyEvmSwap(evmInput(f, { ...ARB_SOL, recipient: THIEF_SOL }))).toThrow(/destinataire à l’arrivée/);
    expect(() => verifyEvmSwap(evmInput(f, ARB_SOL, { tx: { ...evmInput(f, ARB_SOL).tx, data: mutate(f.transactionRequest.data, (_b, nd) => (nd.nonEVMReceiver = ('0x' + '11'.repeat(32)) as Hex)) } }))).toThrow(/destinataire à l’arrivée/);
    expect(() => verifyEvmSwap(evmInput(f, ARB_SOL, { tx: { ...evmInput(f, ARB_SOL).tx, data: mutate(f.transactionRequest.data, (bd) => (bd.receiver = THIEF_EVM)) } }))).toThrow(/hors EVM/);
    expect(() => verifyEvmSwap(evmInput(f, ARB_SOL, { tx: { ...evmInput(f, ARB_SOL).tx, data: mutate(f.transactionRequest.data, (_b, nd) => (nd.refundRecipient = THIEF_EVM)) } }))).toThrow(/remboursement/);
    expect(() => verifyEvmSwap(evmInput(f, ARB_SOL, { tx: { ...evmInput(f, ARB_SOL).tx, data: mutate(f.transactionRequest.data, (bd) => (bd.hasDestinationCall = true)) } }))).toThrow(/appel de contrat/);
    expect(() => verifyEvmSwap(evmInput(f, { ...ARB_SOL, toChain: 'bitcoin', recipient: BTC_TAKER }))).toThrow(/chaîne de destination/);
    expect(() => verifyEvmSwap(evmInput(f, { ...ARB_SOL, buy: SOL_USDC }))).toThrow(/token reçu/);
    expect(() => verifyEvmSwap(evmInput(f, ARB_SOL, { slippageBps: 10 }))).toThrow(/minimum garanti/);
    expect(() => verifyEvmSwap(evmInput(f, ARB_SOL, { tx: { ...evmInput(f, ARB_SOL).tx, data: mutate(f.transactionRequest.data, (_b, nd) => (nd.minAmountOut = 1n)) } }))).toThrow(/minimum garanti/);
    expect(() => verifyEvmSwap(evmInput(f, ARB_SOL, { sellAmount: 30_000_000n }))).toThrow(/première étape/);
    expect(() => verifyEvmSwap(evmInput(f, ARB_SOL, { tx: { ...evmInput(f, ARB_SOL).tx, to: THIEF_EVM } }))).toThrow(/contrat inattendu/);
    // A same-chain decoder never accepts a bridge call (and vice versa).
    expect(() => verifyEvmSwap(evmInput(f, ARB_SOL, { cross: undefined as never }))).toThrow(/fonction du Diamond inconnue/);
  });

  it('refuses the wrong Kyro fee receiver or rate', () => {
    expect(() => verifyEvmSwap(evmInput(f, ARB_SOL, { fee: { kind: 'fee', bps: 70, recipient: THIEF_EVM } }))).toThrow(/frais Kyro absents/);
    expect(() => verifyEvmSwap(evmInput(f, ARB_SOL, { fee: { kind: 'fee', bps: 50, recipient: FEE_EVM } }))).toThrow(/supérieurs au taux/);
  });

  it('NEAR Intents confirms the deposit: recipient, refund, amount, token, minimum, freshness', () => {
    const c = verifyEvmSwap(evmInput(f, ARB_SOL));
    const e = { depositAddress: c.bridge?.depositAddress ?? '', amountIn: c.bridge?.amountIn ?? 0n, fromChain: 42161, toChain: 'solana' as const, buyToken: WSOL_MINT, recipient: SOL_TAKER, refundTo: EVM_TAKER, minAmountOut: c.minBuyAmount, now: NOW };
    const s = f.nearIntentsStatus;
    expect(checkNearDeposit(s, TOKENS, e).minAmountOut).toBe(BigInt(f.estimate.toAmountMin));
    const req = s.quoteResponse?.quoteRequest ?? {};
    const q = s.quoteResponse?.quote ?? {};
    const alt = (r: object, qq: object = {}, top: object = {}): OneClickStatus => ({ ...s, ...top, quoteResponse: { quoteRequest: { ...req, ...r }, quote: { ...q, ...qq } } });
    expect(() => checkNearDeposit(alt({ recipient: THIEF_SOL }), TOKENS, e)).toThrow(/destinataire/);
    expect(() => checkNearDeposit(alt({ recipientType: 'INTENTS' }), TOKENS, e)).toThrow(/destinataire/);
    expect(() => checkNearDeposit(alt({ refundTo: THIEF_EVM }), TOKENS, e)).toThrow(/remboursement/);
    expect(() => checkNearDeposit(alt({}, { amountIn: '1' }), TOKENS, e)).toThrow(/montant déposé/);
    expect(() => checkNearDeposit(alt({}, { minAmountOut: '1' }), TOKENS, e)).toThrow(/minimum garanti/);
    expect(() => checkNearDeposit(alt({ destinationAsset: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near' }), TOKENS, e)).toThrow(/token reçu/);
    expect(() => checkNearDeposit(alt({}, { depositAddress: THIEF_EVM }), TOKENS, e)).toThrow(/adresse de dépôt différente/);
    expect(() => checkNearDeposit(alt({}, {}, { status: 'SUCCESS' }), TOKENS, e)).toThrow(/déjà utilisée/);
    expect(() => checkNearDeposit(s, TOKENS, { ...e, now: Date.parse('2026-12-01T00:00:00Z') })).toThrow(/expiré/);
    expect(() => checkNearDeposit({ status: 'PENDING_DEPOSIT' }, TOKENS, e)).toThrow(/inconnue/);
  });

  describe('through the provider', () => {
    beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
    afterEach(() => vi.useRealTimers());
    const params: QuoteParams = { chain: 42161, toChain: 'solana', recipient: SOL_TAKER, sell: { address: ARB_USDC, symbol: 'USDC', decimals: 6 }, buy: { address: WSOL_MINT, symbol: 'SOL', decimals: 9 }, sellAmount: 20_000_000n, taker: EVM_TAKER, slippageBps: 50 };

    it('asks for the NEAR bridge, our address as toAddress and the EVM fee receiver, then confirms with NEAR Intents', async () => {
      const s = server(f);
      const lifi = new LifiProvider({ fetch: s.fetch, fee: providerFee('lifi', FLAT70), solFee: lifiFeeFor('solana', FLAT70) });
      expect(lifi.supports(params)).toBe(true);
      const q = await lifi.quote(params);
      const sent = new URL(s.seen[0] ?? '').searchParams;
      expect(sent.get('toChain')).toBe('1151111081099710');
      expect(sent.get('toToken')).toBe('11111111111111111111111111111111');
      expect(sent.get('toAddress')).toBe(SOL_TAKER);
      expect(sent.get('allowBridges')).toBe('near');
      expect(sent.get('slippage')).toBe('0.0025'); // half of 0,5 % per leg
      expect(sent.get('distributionFees[0][receiver]')).toBe(FEE_EVM);
      expect(s.seen.some((u) => u.includes('1click.chaindefuser.com/v0/status?depositAddress=' + getAddress('0x0a70e127a87bf8454dfa839d4f9af02610adc9ba')))).toBe(true);
      expect(q.cross).toMatchObject({ fromChain: 42161, toChain: 'solana', recipient: SOL_TAKER, bridge: 'near', bridgeName: 'NEAR Intents' });
      expect(q.etaSecs).toBeGreaterThan(0);
      expect(q.kyroFeeBps).toBe(70);
    });

    it('refuses a quote whose deposit NEAR Intents sends elsewhere, a non-NEAR bridge, or a fee not echoed', async () => {
      const req = f.nearIntentsStatus.quoteResponse?.quoteRequest ?? {};
      const bad = { ...f.nearIntentsStatus, quoteResponse: { ...f.nearIntentsStatus.quoteResponse, quoteRequest: { ...req, recipient: THIEF_SOL } } };
      const lifi = (o: Parameters<typeof server>[1]) => new LifiProvider({ fetch: server(f, o).fetch, fee: providerFee('lifi', FLAT70), solFee: lifiFeeFor('solana', FLAT70) });
      await expect(lifi({ status: bad }).quote(params)).rejects.toThrow(/NEAR Intents : destinataire/);
      await expect(lifi({ lifi: { ...f, tool: 'mayan' } }).quote(params)).rejects.toThrow(/pont « mayan » non vérifiable/);
      await expect(lifi({ lifi: { ...f, estimate: { ...f.estimate, feeCosts: [] } } }).quote(params)).rejects.toThrow(/frais Kyro non appliqués/);
    });

    it('the aggregator keeps it among the quotes (0x and Jupiter do not serve cross-chain)', async () => {
      const providers = createProviders({ fetch: server(f).fetch, hasZeroxKey: () => true, fees: FLAT70 });
      const { quotes, results } = await fetchQuotes(providers, params);
      expect(results.map((r) => r.provider)).toEqual(['lifi']);
      expect(quotes[0]?.provider).toBe('lifi');
    });
  });
});

describe('EVM → Solana token and EVM → Bitcoin (real answers)', () => {
  // Both routes have a source DEX step: LI.FI applied its 0,5 % twice, as for a user who chose 1 %
  // (Kyro asks LI.FI for half per leg). At 0,5 % for the whole route, these minimums are refused.
  it('Base ETH → USDC on Solana: destination asset = the mint, native value = amount sold', () => {
    const f = load('evm-solusdc');
    const o = { chainId: 8453, sell: NATIVE_EVM, sellDecimals: 18, buy: SOL_USDC, buyDecimals: 6, toChain: 'solana' as const, recipient: SOL_TAKER };
    expect(() => verifyEvmSwap(evmInput(f, o))).toThrow(/minimum garanti/);
    const c = verifyEvmSwap(evmInput(f, o, { slippageBps: 100 }));
    expect(c.kyroFee).toBe(70_000_000_000_000n);
    const e = { depositAddress: c.bridge?.depositAddress ?? '', amountIn: c.bridge?.amountIn ?? 0n, fromChain: 8453, toChain: 'solana' as const, buyToken: SOL_USDC, recipient: SOL_TAKER, refundTo: EVM_TAKER, minAmountOut: c.minBuyAmount, now: NOW };
    expect(checkNearDeposit(f.nearIntentsStatus, TOKENS, e).destinationAsset).toMatch(/^nep141:sol-/);
    expect(() => checkNearDeposit(f.nearIntentsStatus, TOKENS, { ...e, buyToken: WSOL_MINT })).toThrow(/token reçu/);
  });

  it('Arbitrum USDC → BTC: receiver = the 32 program words of our bc1q address, confirmed by NEAR Intents', () => {
    const f = load('evm-btc');
    const o = { chainId: 42161, sell: ARB_USDC, sellDecimals: 6, buy: 'bitcoin', buyDecimals: 8, toChain: 'bitcoin' as const, recipient: BTC_TAKER };
    const c = verifyEvmSwap(evmInput(f, o, { slippageBps: 100 }));
    expect(c.recipient).toBe(BTC_TAKER);
    expect(() => verifyEvmSwap(evmInput(f, { ...o, recipient: KYRO_SWAP_FEE.recipients.bitcoin ?? '' }, { slippageBps: 100 }))).toThrow(/destinataire à l’arrivée/);
    // Taproot (52 words) cannot be written unambiguously: refused.
    expect(nonEvmReceiverWord('bitcoin', 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297')).toBeNull();
    const e = { depositAddress: c.bridge?.depositAddress ?? '', amountIn: c.bridge?.amountIn ?? 0n, fromChain: 42161, toChain: 'bitcoin' as const, buyToken: 'bitcoin', recipient: BTC_TAKER, refundTo: EVM_TAKER, minAmountOut: c.minBuyAmount, now: NOW };
    expect(checkNearDeposit(f.nearIntentsStatus, TOKENS, e).destinationAsset).toBe('nep141:btc.omft.near');
  });
});

const solInput = (f: Fixture, over: Partial<LifiSolanaCheckInput> = {}): LifiSolanaCheckInput => {
  const wire = f.transactionRequest.data;
  return { wire, summary: summaryOf(wire, staticKeys(wire), SOL_TAKER), taker: SOL_TAKER, sellMint: f.request.fromToken === '11111111111111111111111111111111' ? WSOL_MINT : String(f.request.fromToken), sellAmount: BigInt(f.request.fromAmount ?? 0), fee: { bps: 70, recipient: FEE_SOL }, ...over };
};
const withIx = (s: SolTxSummary, ix: SolInstruction): SolTxSummary => ({ ...s, instructions: [...s.instructions, ix] });

describe('Solana → EVM (real LI.FI Solana transactions, NEAR Intents)', () => {
  it('SOL → ETH Arbitrum: Kyro fee 0,7 % in SOL to the Solana fee wallet, LI.FI 0,25 %, one deposit', async () => {
    const f = load('sol-evm');
    const c = await verifyLifiSolanaSource(solInput(f));
    expect(c).toMatchObject({ depositAddress: 'AmcBByD5w4PdFHdknnAtDFLcVYkXPq8fu5CuNb5Xa1CB', kyroFee: 3_500_000n, lifiFee: 1_250_000n, amountIn: 495_250_000n });
    const e = { depositAddress: c.depositAddress, amountIn: c.amountIn, fromChain: 'solana' as const, toChain: 42161, buyToken: NATIVE_EVM, recipient: EVM_TAKER, refundTo: SOL_TAKER, minAmountOut: BigInt(f.estimate.toAmountMin), now: NOW };
    expect(checkNearDeposit(f.nearIntentsStatus, TOKENS, e).minAmountOut).toBe(BigInt(f.estimate.toAmountMin));
    expect(solWireCostLamports(f.transactionRequest.data)).toBeGreaterThan(5_000n);
  });

  it('refuses: wrong fee receiver or rate, third-party transfer, foreign program, other fee payer', async () => {
    const f = load('sol-evm');
    const base = solInput(f);
    await expect(verifyLifiSolanaSource({ ...base, fee: { bps: 70, recipient: THIEF_SOL } })).rejects.toThrow(/plusieurs destinataires/);
    await expect(verifyLifiSolanaSource({ ...base, fee: { bps: 50, recipient: FEE_SOL } })).rejects.toThrow(/supérieurs au taux/);
    await expect(verifyLifiSolanaSource({ ...base, summary: withIx(base.summary, { type: 'systemTransfer', from: SOL_TAKER, to: THIEF_SOL, lamports: '1' }) })).rejects.toThrow(/décodage du coffre|plusieurs destinataires/);
    const swapped = { ...base.summary, instructions: base.summary.instructions.map((x) => (x.type === 'systemTransfer' && x.to === 'AmcBByD5w4PdFHdknnAtDFLcVYkXPq8fu5CuNb5Xa1CB' ? { ...x, lamports: '495249999' } : x)) };
    await expect(verifyLifiSolanaSource({ ...base, summary: swapped })).rejects.toThrow(/montants envoyés/);
    const foreign = { ...base.summary, instructions: base.summary.instructions.map((x) => (x.type === 'unknown' ? { ...x, programId: THIEF_SOL } : x)) };
    await expect(verifyLifiSolanaSource({ ...base, summary: foreign })).rejects.toThrow(/programme incohérent|non autorisé/);
    await expect(verifyLifiSolanaSource({ ...base, summary: { ...base.summary, feePayer: THIEF_SOL } })).rejects.toThrow(/payeur/);
    await expect(verifyLifiSolanaSource({ ...base, summary: { ...base.summary, warnings: [...base.summary.warnings, { kind: 'delegation', instruction: 0 }] } })).rejects.toThrow(/delegation/);
    await expect(verifyLifiSolanaSource({ ...base, sellAmount: 400_000_000n })).rejects.toThrow(/montants envoyés|supérieurs/);
    // The NEAR deposit must deliver to OUR EVM address.
    const c = await verifyLifiSolanaSource(base);
    expect(() => checkNearDeposit(f.nearIntentsStatus, TOKENS, { depositAddress: c.depositAddress, amountIn: c.amountIn, fromChain: 'solana', toChain: 42161, buyToken: NATIVE_EVM, recipient: THIEF_EVM, refundTo: SOL_TAKER, minAmountOut: 1n, now: NOW })).toThrow(/destinataire/);
  });

  it('USDC (SPL) → USDC Base: TransferChecked from our account, Kyro fee to the fee wallet’s USDC account, deposit account created here', async () => {
    const f = load('solusdc-evm');
    const c = await verifyLifiSolanaSource(solInput(f));
    expect(c).toMatchObject({ depositAddress: 'CSJsZwQbsEcZC2zBYYRD6q7ykaamSqB4UUvcwZSBNq4w', kyroFee: 350_000n, lifiFee: 125_000n, amountIn: 49_525_000n });
    expect(LIFI_SOLANA_FEE_WALLET).toBe('34FKjAdVcTax2DHqV2XnbXa9J3zmyKcFuFKWbcmgxjgm');
    const e = { depositAddress: c.depositAddress, amountIn: c.amountIn, fromChain: 'solana' as const, toChain: 8453, buyToken: BASE_USDC, recipient: EVM_TAKER, refundTo: SOL_TAKER, minAmountOut: BigInt(f.estimate.toAmountMin), now: NOW };
    expect(checkNearDeposit(f.nearIntentsStatus, TOKENS, e).destinationAsset).toMatch(/^nep141:base-0x833589/);
    // Selling another mint than the one transferred, or a transfer to an account nobody created here: refused.
    await expect(verifyLifiSolanaSource(solInput(f, { sellMint: WSOL_MINT }))).rejects.toThrow(/inattendu/);
    const s = solInput(f).summary;
    const noCreate = { ...s, instructions: s.instructions.map((x) => (x.type === 'ataCreate' ? { ...x, owner: THIEF_SOL } : x)) };
    await expect(verifyLifiSolanaSource(solInput(f, { summary: noCreate }))).rejects.toThrow(/compte de token inconnu/);
  });

  describe('through the provider', () => {
    beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
    afterEach(() => vi.useRealTimers());

    it('sends the SOLANA fee receiver, builds a fresh transaction, verifies it and confirms with NEAR Intents', async () => {
      const f = load('sol-evm');
      const s = server(f);
      const lifi = new LifiProvider({ fetch: s.fetch, fee: providerFee('lifi', FLAT70), solFee: lifiFeeFor('solana', FLAT70) });
      const params: QuoteParams = { chain: 'solana', toChain: 42161, recipient: EVM_TAKER, sell: { address: WSOL_MINT, symbol: 'SOL', decimals: 9 }, buy: { address: NATIVE_EVM, symbol: 'ETH', decimals: 18 }, sellAmount: 500_000_000n, taker: SOL_TAKER, slippageBps: 50, nativePriceFiat: 90 };
      const q = await lifi.quote(params);
      const sent = new URL(s.seen[0] ?? '').searchParams;
      expect(sent.get('fromToken')).toBe('11111111111111111111111111111111');
      expect(sent.get('distributionFees[0][receiver]')).toBe(FEE_SOL);
      expect(q.minBuyAmount).toBe(BigInt(f.estimate.toAmountMin));
      expect(q.gasFeeFiat).toBeGreaterThan(0);
      if (q.tx.kind !== 'solana' || !q.tx.verify) throw new Error('expected a verified Solana route');
      const wire = await q.tx.build();
      const c = await q.tx.verify(wire, summaryOf(wire, staticKeys(wire), SOL_TAKER));
      expect(c).toMatchObject({ depositAddress: 'AmcBByD5w4PdFHdknnAtDFLcVYkXPq8fu5CuNb5Xa1CB', kyroFee: 3_500_000n });
      // An EVM fee receiver for a Solana source would be refused by li.quest: the fee echo must name the Solana wallet.
      const evmEcho = new LifiProvider({ fetch: server(f).fetch, fee: providerFee('lifi', FLAT70), solFee: providerFee('lifi', FLAT70) });
      await expect(evmEcho.quote(params)).rejects.toThrow(/frais Kyro non appliqués/);
      // No Solana fee wallet configured ⇒ no Solana-source route at all.
      const none = new LifiProvider({ fetch: server(f).fetch, fee: providerFee('lifi', FLAT70), solFee: { kind: 'unavailable', reason: 'Adresse Solana des frais Kyro non configurée' } });
      await expect(none.quote(params)).rejects.toThrow(/Solana des frais/);
    });
  });
});

describe('cross-chain status', () => {
  it('reads li.quest /v1/status with LI.FI chain ids', async () => {
    let url = '';
    const st = await lifiTransferStatus(async (r) => ((url = r.url), { status: 200, body: JSON.stringify({ status: 'DONE', substatus: 'COMPLETED', receiving: { txHash: '0xabc' } }) }), { txHash: '5sig', fromChain: 'solana', toChain: 42161, bridge: 'near' });
    expect(st).toEqual({ status: 'DONE', substatus: 'COMPLETED', receivingTxHash: '0xabc' });
    expect(url).toBe('https://li.quest/v1/status?txHash=5sig&fromChain=1151111081099710&toChain=42161&bridge=near');
  });
});

describe('demo mode: cross-chain answers (mock-lifi-cross.ts) pass the same checks', () => {
  it('EVM → Solana / Bitcoin and Solana → EVM, SOL and USDC, end to end with the demo decoder and 1Click', async () => {
    const backend = createMockBackend({ network: 'mainnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } });
    setBackend(backend.invoke);
    const a = backend.chain.accounts;
    const evm = getAddress(a.evm.address);
    const providers = createProviders({ hasZeroxKey: () => true });
    const usdcArb = { address: ARB_USDC, symbol: 'USDC', decimals: 6 };
    const eth = { address: NATIVE_EVM, symbol: 'ETH', decimals: 18 };
    for (const [sell, buy, toChain, recipient, amount] of [
      [usdcArb, { address: WSOL_MINT, symbol: 'SOL', decimals: 9 }, 'solana', a.sol.address, 50_000_000n],
      [eth, { address: SOL_USDC, symbol: 'USDC', decimals: 6 }, 'solana', a.sol.address, 10n ** 16n],
      [usdcArb, { address: 'bitcoin', symbol: 'BTC', decimals: 8 }, 'bitcoin', a.btc.segwit.address, 50_000_000n],
      [usdcArb, eth, 8453, evm, 50_000_000n],
    ] as const) {
      const out = await fetchQuotes(providers, { chain: 42161, toChain, recipient, sell, buy, sellAmount: amount, taker: evm, slippageBps: 50 });
      expect(out.results.filter((r) => r.error)).toEqual([]);
      expect(out.quotes[0]?.cross).toMatchObject({ toChain, recipient, bridge: 'near' });
      // Real curve, no price given → 90 bps, asked for and found in the calldata.
      expect(out.quotes[0]?.kyroFeeBps).toBe(90);
      expect(out.quotes[0]?.evmCheck?.kyroFee).toBe((amount * 90n) / 10_000n);
    }
    for (const [sell, amount] of [[{ address: WSOL_MINT, symbol: 'SOL', decimals: 9 }, 500_000_000n], [{ address: SOL_USDC, symbol: 'USDC', decimals: 6 }, 50_000_000n]] as const) {
      const out = await fetchQuotes(providers, { chain: 'solana', toChain: 42161, recipient: evm, sell, buy: eth, sellAmount: amount, taker: a.sol.address, slippageBps: 50 });
      expect(out.results.filter((r) => r.error)).toEqual([]);
      const q = out.quotes[0];
      if (q?.tx.kind !== 'solana' || !q.tx.verify) throw new Error('expected a verified Solana route');
      const wire = await q.tx.build();
      const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
      const summary = (await backend.invoke('sol_decode_tx', { message: getBase64Decoder().decode(tx.messageBytes) })) as SolTxSummary;
      const c = await q.tx.verify(wire, summary);
      expect(c.kyroFee).toBe((amount * 90n) / 10_000n);
    }
  });
});
