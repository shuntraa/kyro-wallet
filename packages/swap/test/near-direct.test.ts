// NEAR Intents 1Click used directly (providers/near.ts): swaps FROM Bitcoin, Litecoin, Dogecoin,
// TRON (TRX, USDT TRC-20), XRP, Cardano, and from EVM / Solana TO the chains LI.FI does not reach.
// Against REAL 1Click answers (fixtures/cross/1click-direct.json, recorded 01/11/2026: `POST
// /v0/quote` with Kyro's app fee, then `GET /v0/status` of each deposit address; read-only, nothing
// was ever deposited). The recorded « user » addresses are the owner's own Kyro addresses.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBackend, type NetRequest, type NetResponse } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import {
  checkNearDeposit,
  checkOneClickQuote,
  createProviders,
  fetchQuotes,
  KYRO_SWAP_FEE,
  NATIVE_EVM,
  NEAR_MIN_TIME_LEFT_MS,
  NearIntentsProvider,
  nearDepositStatus,
  nearIntentsAppFee,
  oneClickAsset,
  WSOL_MINT,
  type OneClickQuoteAnswer,
  type OneClickStatus,
  type OneClickToken,
  type QuoteParams,
  type SwapChain,
} from '../src';

interface Route {
  quote: OneClickQuoteAnswer;
  status: OneClickStatus;
}
const FIX = JSON.parse(readFileSync(new URL('./fixtures/cross/1click-direct.json', import.meta.url), 'utf8')) as { tokens: OneClickToken[]; dry: OneClickQuoteAnswer; routes: Record<string, Route> };
const TOKENS = FIX.tokens;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const R = KYRO_SWAP_FEE.recipients;
const FEE_ACCOUNT = R.evm.toLowerCase();
const ONE_CLICK_ACCOUNT = '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const THIEF_EVM = '0xbad0000000000000000000000000000000000bad';
/** Recorded 01:29–01:30 UTC; the request deadline is +3 h. */
const NOW = Date.parse('2026-11-01T01:31:00Z');
const FEE = { bps: 70, recipient: FEE_ACCOUNT, requestBps: 140 };

/** [fixture, from, to, sell token, buy token, sell decimals, buy decimals, refund (ours on `from`), recipient (ours on `to`)]. */
const ROUTES: ReadonlyArray<[string, SwapChain, SwapChain, string, string, number, number, string, string]> = [
  ['btc-eth', 'bitcoin', 1, 'bitcoin', NATIVE_EVM, 8, 18, R.bitcoin ?? '', R.evm],
  ['ltc-sol', 'litecoin', 'solana', 'litecoin', WSOL_MINT, 8, 9, R.litecoin ?? '', R.solana],
  ['doge-btc', 'dogecoin', 'bitcoin', 'dogecoin', 'bitcoin', 8, 8, R.dogecoin ?? '', R.bitcoin ?? ''],
  ['trx-eth', 'tron', 1, 'tron', NATIVE_EVM, 6, 18, R.tron ?? '', R.evm],
  ['usdt-trc20-solusdc', 'tron', 'solana', USDT_TRC20, SOL_USDC, 6, 6, R.tron ?? '', R.solana],
  ['xrp-sol', 'xrp', 'solana', 'xrp', WSOL_MINT, 6, 9, R.xrp ?? '', R.solana],
  ['ada-eth', 'cardano', 1, 'cardano', NATIVE_EVM, 6, 18, R.cardano ?? '', R.evm],
  ['arbeth-ltc', 42161, 'litecoin', NATIVE_EVM, 'litecoin', 18, 8, R.evm, R.litecoin ?? ''],
];

function setup(name: string) {
  const row = ROUTES.find((r) => r[0] === name);
  if (!row) throw new Error(name);
  const [, from, to, sell, buy, sd, bd, refundTo, recipient] = row;
  const f = FIX.routes[name] as Route;
  const origin = oneClickAsset(TOKENS, from, sell, sd);
  const dest = oneClickAsset(TOKENS, to, buy, bd);
  const amount = BigInt(f.quote.quoteRequest?.amount ?? '0');
  const expect = { originAsset: origin?.assetId ?? '', destinationAsset: dest?.assetId ?? '', amount, recipient, refundTo, fromChain: from, toChain: to, slippageBps: 100, fee: FEE, dry: false };
  const params: QuoteParams = { chain: from, toChain: to, recipient, sell: { address: sell, symbol: 'S', decimals: sd }, buy: { address: buy, symbol: 'B', decimals: bd }, sellAmount: amount, taker: refundTo, slippageBps: 100 };
  return { f, expect, params, depositAddress: f.quote.quote?.depositAddress ?? '' };
}

/** What `/v0/status` must confirm for a direct route (the provider passes the same). */
const depositExpect = (s: ReturnType<typeof setup>, over: Partial<Parameters<typeof checkNearDeposit>[2]> = {}) => ({
  depositAddress: s.depositAddress,
  amountIn: s.expect.amount,
  fromChain: s.expect.fromChain,
  toChain: s.expect.toChain,
  buyToken: s.params.buy.address,
  recipient: s.expect.recipient,
  refundTo: s.expect.refundTo,
  minAmountOut: BigInt(s.f.quote.quote?.minAmountOut ?? '0'),
  appFee: { recipient: FEE_ACCOUNT, bps: 70, oneClickMaxBps: 70 },
  minTimeLeftMs: NEAR_MIN_TIME_LEFT_MS,
  now: NOW,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Kyro fee through 1Click appFees (live answers)', () => {
  it('1Click keeps half of what is asked: 140 bps asked → 70 to the Kyro account + 70 to 1Click', () => {
    expect(nearIntentsAppFee()).toEqual({ kind: 'fee', bps: 70, recipient: FEE_ACCOUNT, requestBps: 140 });
    expect(FIX.dry.quoteRequest?.appFees).toEqual([
      { recipient: FEE_ACCOUNT, fee: 70 },
      { recipient: ONE_CLICK_ACCOUNT, fee: 70 },
    ]);
    // Over 1Click's 500 bps cap once doubled: no NEAR Intents route rather than a lower fee.
    expect(nearIntentsAppFee({ ...KYRO_SWAP_FEE, bps: 300 }).kind).toBe('unavailable');
    expect(nearIntentsAppFee({ ...KYRO_SWAP_FEE, recipients: { ...R, evm: '0x1234' } }).kind).toBe('unavailable');
  });

  it.each(ROUTES.map((r) => r[0]))('%s: accepted — our recipient and refund, our fee echoed, minimum within the slippage, SIMPLE deposit', (name) => {
    const s = setup(name);
    expect(s.expect.originAsset).not.toBe('');
    expect(s.expect.destinationAsset).not.toBe('');
    const c = checkOneClickQuote(s.f.quote, s.expect);
    expect(c).toMatchObject({ depositAddress: s.depositAddress, kyroFeeBps: 70, oneClickFeeBps: 70 });
    expect(c.minAmountOut).toBe(BigInt(s.f.quote.quote?.minAmountOut ?? '0'));
    // And 1Click's own status of that deposit address says the same.
    const n = checkNearDeposit(s.f.status, TOKENS, depositExpect(s));
    expect(n).toMatchObject({ kyroFeeBps: 70, otherFeeBps: 70, minAmountOut: c.minAmountOut });
    // Deadline: the earlier of 1Click's (3 days) and the one Kyro asked (3 h).
    expect(n.deadline).toBe(Date.parse(s.f.quote.quoteRequest?.deadline ?? ''));
  });
});

describe('refused, never signed', () => {
  const s = setup('btc-eth');
  const refuse = (edit: (q: OneClickQuoteAnswer) => void, why: RegExp) => {
    const q = clone(s.f.quote);
    edit(q);
    expect(() => checkOneClickQuote(q, s.expect)).toThrow(why);
  };
  const req = (q: OneClickQuoteAnswer) => q.quoteRequest as NonNullable<OneClickQuoteAnswer['quoteRequest']>;
  const quote = (q: OneClickQuoteAnswer) => q.quote as NonNullable<OneClickQuoteAnswer['quote']>;

  it('the Kyro fee: missing, another account, wrong rate, twice, or 1Click taking more than its half', () => {
    refuse((q) => delete req(q).appFees, /frais Kyro absents/);
    refuse((q) => (req(q).appFees = [{ recipient: THIEF_EVM, fee: 70 }, { recipient: ONE_CLICK_ACCOUNT, fee: 70 }]), /frais Kyro absents/);
    refuse((q) => (req(q).appFees = [{ recipient: FEE_ACCOUNT, fee: 35 }, { recipient: ONE_CLICK_ACCOUNT, fee: 105 }]), /35 bps au lieu de 70/);
    refuse((q) => (req(q).appFees = [{ recipient: FEE_ACCOUNT, fee: 70 }, { recipient: FEE_ACCOUNT, fee: 70 }]), /en double/);
    refuse((q) => (req(q).appFees = [{ recipient: FEE_ACCOUNT, fee: 70 }, { recipient: ONE_CLICK_ACCOUNT, fee: 71 }]), /part de NEAR Intents \(71 bps\)/);
    refuse((q) => (req(q).appFees = [{ recipient: FEE_ACCOUNT, fee: 70 }, { recipient: ONE_CLICK_ACCOUNT, fee: 70 }, { recipient: THIEF_EVM, fee: 10 }]), /part de NEAR Intents/);
  });

  it('delivery or refund elsewhere, another amount or token, a memo deposit, a lower minimum', () => {
    refuse((q) => (req(q).recipient = THIEF_EVM), /destinataire/);
    refuse((q) => (req(q).recipientType = 'INTENTS'), /destinataire/);
    refuse((q) => (req(q).refundTo = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), /remboursement/);
    refuse((q) => (req(q).refundType = 'INTENTS'), /remboursement/);
    refuse((q) => (quote(q).amountIn = '100001'), /montant/);
    refuse((q) => (req(q).destinationAsset = 'nep141:sol.omft.near'), /tokens du devis/);
    refuse((q) => (req(q).depositMode = 'MEMO'), /mémo/);
    refuse((q) => (quote(q).depositMemo = '12345'), /mémo/);
    refuse((q) => (req(q).swapType = 'EXACT_OUTPUT'), /type d’échange/);
    refuse((q) => (quote(q).minAmountOut = ((BigInt(quote(q).amountOut ?? '0') * 9_800n) / 10_000n).toString()), /slippage/);
    refuse((q) => (quote(q).depositAddress = s.expect.refundTo), /ta propre adresse/);
    refuse((q) => delete quote(q).depositAddress, /adresse de dépôt absente/);
    refuse((q) => delete q.quote, /réponse illisible/);
  });

  it('1Click status: already used, other terms than the quote, too close to its deadline', () => {
    const bad = (edit: (st: OneClickStatus) => void, why: RegExp, over = {}) => {
      const st = clone(s.f.status);
      edit(st);
      expect(() => checkNearDeposit(st, TOKENS, depositExpect(s, over))).toThrow(why);
    };
    bad((st) => (st.status = 'PROCESSING'), /déjà utilisée/);
    bad((st) => ((st.quoteResponse?.quoteRequest as { appFees?: unknown }).appFees = [{ recipient: FEE_ACCOUNT, fee: 35 }]), /35 bps/);
    bad((st) => ((st.quoteResponse?.quoteRequest as { recipient?: string }).recipient = THIEF_EVM), /destinataire/);
    bad((st) => ((st.quoteResponse?.quoteRequest as { depositMode?: string }).depositMode = 'MEMO'), /mémo/);
    bad(() => undefined, /trop proche/, { now: Date.parse('2026-11-01T03:00:00Z') });
    bad(() => undefined, /plus bas/, { minAmountOut: BigInt(s.f.quote.quote?.minAmountOut ?? '0') + 1n });
  });
});

describe('the provider', () => {
  /** Serves the recorded token list, the route's quote (dry: without its deposit address) and its status. */
  function server(name: string, over: { quote?: OneClickQuoteAnswer } = {}) {
    const f = FIX.routes[name] as Route;
    const bodies: Array<Record<string, unknown>> = [];
    const seen: string[] = [];
    const fetch = async (r: NetRequest): Promise<NetResponse> => {
      const u = new URL(r.url);
      seen.push(`${r.method} ${u.host}${u.pathname}`);
      if (u.pathname === '/v0/tokens') return { status: 200, body: JSON.stringify(TOKENS) };
      if (u.pathname === '/v0/status') return { status: 200, body: JSON.stringify(f.status) };
      if (u.pathname === '/v0/quote' && r.method === 'POST') {
        const body = JSON.parse(r.body ?? '{}') as Record<string, unknown>;
        bodies.push(body);
        const q = clone(over.quote ?? f.quote);
        if (body.dry) {
          delete q.quote?.depositAddress;
          if (q.quoteRequest) q.quoteRequest.dry = true;
        }
        return { status: 201, body: JSON.stringify(q) };
      }
      return { status: 404, body: '{}' };
    };
    return { fetch, bodies, seen };
  }

  it('serves only what LI.FI cannot: from the NEAR-only chains, and from EVM / Solana to them', () => {
    const p = new NearIntentsProvider({ fee: { kind: 'fee', bps: 70, recipient: R.evm, requestBps: 140 } });
    const base = setup('btc-eth').params;
    expect(p.supports(base)).toBe(true);
    expect(p.supports({ ...base, chain: 1, toChain: 'solana' })).toBe(false);
    expect(p.supports({ ...base, chain: 1, toChain: 'bitcoin' })).toBe(false);
    expect(p.supports({ ...base, chain: 'solana', toChain: 'solana' })).toBe(false);
    expect(p.supports({ ...base, chain: 42161, toChain: 'litecoin' })).toBe(true);
    expect(p.supports({ ...base, chain: 'tron', toChain: 'tron' })).toBe(true);
    expect(p.supports({ ...base, chain: 11155111, toChain: 'litecoin' })).toBe(false);
  });

  it.each(ROUTES.map((r) => r[0]))('%s: dry quote, then a real one confirmed by 1Click (prepare, reconfirm)', async (name) => {
    const s = setup(name);
    const srv = server(name);
    const p = new NearIntentsProvider({ fetch: srv.fetch, fee: nearIntentsAppFee() });
    const q = await p.quote(s.params);
    expect(q).toMatchObject({ provider: 'near', kyroFeeBps: 70, providerFeeIncluded: true, cross: { fromChain: s.expect.fromChain, toChain: s.expect.toChain, recipient: s.expect.recipient, bridge: '1click' } });
    expect(srv.bodies[0]).toMatchObject({
      dry: true,
      swapType: 'EXACT_INPUT',
      depositMode: 'SIMPLE',
      slippageTolerance: 100,
      originAsset: s.expect.originAsset,
      destinationAsset: s.expect.destinationAsset,
      amount: s.expect.amount.toString(),
      refundTo: s.expect.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: s.expect.recipient,
      recipientType: 'DESTINATION_CHAIN',
      appFees: [{ recipient: FEE_ACCOUNT, fee: 140 }],
    });
    if (q.tx.kind !== 'deposit') throw new Error('deposit expected');
    const plan = await q.tx.prepare();
    expect(srv.bodies[1]?.dry).toBe(false);
    expect(plan).toMatchObject({ depositAddress: s.depositAddress, amountIn: s.expect.amount, kyroFeeBps: 70, oneClickFeeBps: 70 });
    expect(await q.tx.reconfirm(plan)).toEqual(plan);
    expect(srv.seen.filter((x) => x.includes('/v0/status'))).toHaveLength(2);
  });

  it('a real quote whose terms differ from the dry one is refused before any transfer is built', async () => {
    const s = setup('xrp-sol');
    const f = FIX.routes['xrp-sol'] as Route;
    const q0 = await new NearIntentsProvider({ fetch: server('xrp-sol').fetch, fee: nearIntentsAppFee() }).quote(s.params);
    if (q0.tx.kind !== 'deposit') throw new Error('deposit expected');
    // Same dry answer, but 1Click's status of the deposit address now pays someone else.
    const st = clone(f.status);
    (st.quoteResponse?.quoteRequest as { recipient?: string }).recipient = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
    const fetch = async (r: NetRequest): Promise<NetResponse> => (r.url.includes('/v0/status') ? { status: 200, body: JSON.stringify(st) } : server('xrp-sol').fetch(r));
    const q = await new NearIntentsProvider({ fetch, fee: nearIntentsAppFee() }).quote(s.params);
    if (q.tx.kind !== 'deposit') throw new Error('deposit expected');
    await expect(q.tx.prepare()).rejects.toThrow(/destinataire/);
  });

  it('if 1Click applies its documented keyless policy (your fee kept whole + 25 bps), Kyro asks again for exactly 70', async () => {
    const s = setup('btc-eth');
    const f = FIX.routes['btc-eth'] as Route;
    const asked: number[] = [];
    const fetch = async (r: NetRequest): Promise<NetResponse> => {
      if (!r.url.endsWith('/v0/quote')) return server('btc-eth').fetch(r);
      const body = JSON.parse(r.body ?? '{}') as { dry: boolean; appFees: Array<{ fee: number }> };
      const fee = body.appFees[0]?.fee ?? 0;
      asked.push(fee);
      const q = clone(f.quote);
      if (q.quoteRequest) q.quoteRequest.appFees = [{ recipient: FEE_ACCOUNT, fee }, { recipient: ONE_CLICK_ACCOUNT, fee: 25 }];
      if (body.dry) delete q.quote?.depositAddress;
      return { status: 201, body: JSON.stringify(q) };
    };
    const q = await new NearIntentsProvider({ fetch, fee: nearIntentsAppFee() }).quote(s.params);
    expect(asked).toEqual([140, 70]);
    expect(q.kyroFeeBps).toBe(70);
    // Never more than our rate to us, never a silent cut: an echo of 35 for 70 asked is refused.
    const low = async (r: NetRequest): Promise<NetResponse> => {
      if (!r.url.endsWith('/v0/quote')) return server('btc-eth').fetch(r);
      const q2 = clone(f.quote);
      if (q2.quoteRequest) q2.quoteRequest.appFees = [{ recipient: FEE_ACCOUNT, fee: 35 }, { recipient: ONE_CLICK_ACCOUNT, fee: 105 }];
      return { status: 201, body: JSON.stringify(q2) };
    };
    await expect(new NearIntentsProvider({ fetch: low, fee: nearIntentsAppFee() }).quote(s.params)).rejects.toThrow(/35 bps au lieu de 70/);
  });

  it('the aggregator: from Bitcoin only NEAR Intents answers (LI.FI, 0x, Jupiter are not asked)', async () => {
    const s = setup('btc-eth');
    const srv = server('btc-eth');
    const out = await fetchQuotes(createProviders({ fetch: srv.fetch, hasZeroxKey: () => true }), s.params);
    expect(out.results.filter((r) => r.error)).toEqual([]);
    expect(out.quotes.map((q) => q.provider)).toEqual(['near']);
    expect(srv.seen.every((x) => x.includes('1click.chaindefuser.com'))).toBe(true);
  });

  it('history: 1Click status of the deposit address', async () => {
    let url = '';
    const st = await nearDepositStatus(async (r) => ((url = r.url), { status: 200, body: JSON.stringify({ status: 'SUCCESS', swapDetails: { destinationChainTxHashes: [{ hash: '0xabc' }] } }) }), 'bc1qfm26lzq7yaqap99dp689wfn4pkfpd6r2m7n55d');
    expect(st).toEqual({ status: 'SUCCESS', destinationTxHash: '0xabc' });
    expect(url).toBe('https://1click.chaindefuser.com/v0/status?depositAddress=bc1qfm26lzq7yaqap99dp689wfn4pkfpd6r2m7n55d');
  });
});

describe('demo mode: direct 1Click answers (mock-lifi-cross.ts) pass the same checks', () => {
  it('BTC, LTC, DOGE, TRX, USDT TRC-20, XRP, ADA → another chain, and ETH Arbitrum → LTC', async () => {
    vi.useRealTimers();
    const backend = createMockBackend({ network: 'mainnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } });
    setBackend(backend.invoke);
    const a = backend.chain.accounts;
    const providers = createProviders({ hasZeroxKey: () => true });
    const cases: Array<[SwapChain, string, number, string, SwapChain, string, number, string, bigint]> = [
      ['bitcoin', 'bitcoin', 8, a.btc.segwit.address, 1, NATIVE_EVM, 18, a.evm.address, 1_000_000n],
      ['litecoin', 'litecoin', 8, a.ltc.address, 'solana', WSOL_MINT, 9, a.sol.address, 100_000_000n],
      ['dogecoin', 'dogecoin', 8, a.doge.address, 'bitcoin', 'bitcoin', 8, a.btc.segwit.address, 100_000_000_000n],
      ['tron', 'tron', 6, a.tron.address, 1, NATIVE_EVM, 18, a.evm.address, 500_000_000n],
      ['tron', USDT_TRC20, 6, a.tron.address, 'solana', SOL_USDC, 6, a.sol.address, 120_000_000n],
      ['xrp', 'xrp', 6, a.xrp.address, 'solana', WSOL_MINT, 9, a.sol.address, 50_000_000n],
      ['cardano', 'cardano', 6, a.cardano.address, 1, NATIVE_EVM, 18, a.evm.address, 300_000_000n],
      [42161, NATIVE_EVM, 18, a.evm.address, 'litecoin', 'litecoin', 8, a.ltc.address, 10n ** 16n],
    ];
    for (const [chain, sell, sd, taker, toChain, buy, bd, recipient, amount] of cases) {
      const out = await fetchQuotes(providers, { chain, toChain, recipient, sell: { address: sell, symbol: 'S', decimals: sd }, buy: { address: buy, symbol: 'B', decimals: bd }, sellAmount: amount, taker, slippageBps: 100 });
      expect(out.results.filter((r) => r.error)).toEqual([]);
      const q = out.quotes[0];
      if (q?.tx.kind !== 'deposit') throw new Error(`${String(chain)}: deposit expected`);
      expect(q.kyroFeeBps).toBe(70);
      const plan = await q.tx.prepare();
      expect(plan).toMatchObject({ amountIn: amount, kyroFeeBps: 70, oneClickFeeBps: 70 });
      expect(plan.depositAddress).not.toBe(taker);
    }
  }, 30_000);
});
