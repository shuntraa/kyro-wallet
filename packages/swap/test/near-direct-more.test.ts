// NEAR Intents 1Click direct routes added on 01/11/2026: from Bitcoin Cash, Dash, Zcash, TON, Sui,
// Aptos, from Gnosis (xDAI), and to Stellar (arrival only). Against REAL 1Click answers
// (fixtures/cross/1click-direct-more.json: `POST /v0/quote` with Kyro's app fee, then `GET
// /v0/status` of each deposit address; read-only, nothing was ever deposited). The non-EVM « user »
// addresses are sample addresses from the chain adapters' tests; the EVM one is the owner's.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkNearDeposit,
  checkOneClickQuote,
  KYRO_SWAP_FEE,
  LifiProvider,
  NATIVE_EVM,
  NEAR_MIN_TIME_LEFT_MS,
  NearIntentsProvider,
  ONE_CLICK_ARRIVAL_ONLY,
  ONE_CLICK_CHAINS,
  oneClickAsset,
  sameChainAddress,
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
const FIX = JSON.parse(readFileSync(new URL('./fixtures/cross/1click-direct-more.json', import.meta.url), 'utf8')) as { tokens: OneClickToken[]; routes: Record<string, Route>; xlmOrigin: { http: number; message: string } };
const TOKENS = FIX.tokens;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const EVM = KYRO_SWAP_FEE.recipients.evm;
const FEE_ACCOUNT = EVM.toLowerCase();
const FEE = { bps: 70, recipient: FEE_ACCOUNT, requestBps: 140 };
const A = {
  bch: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
  dash: 'XdTw4G5AWW4cogGd7ayybyBNDbuB45UpgH',
  zec: 't1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC',
  xlm: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6',
  ton: 'UQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorhqg',
  sui: '0x7d20dcdb2bca4f508ea9613994683eb4e76e9c4ed371169677c1be02aaf0b58e',
  apt: '0x3c9f2a6be1c3b0d8e2f4a5d6c7b8a9e0f1d2c3b4a5968778695a4b3c2d1e0f9a',
};
/** Recorded 14:02–14:03 UTC; the request deadline is +3 h. */
const NOW = Date.parse('2026-11-01T14:04:00Z');

/** [fixture, from, to, sell token, buy token, sell decimals, buy decimals, refund (ours on `from`), recipient (ours on `to`)]. */
const ROUTES: ReadonlyArray<[string, SwapChain, SwapChain, string, string, number, number, string, string]> = [
  ['bch-eth', 'bitcoincash', 1, 'bitcoincash', NATIVE_EVM, 8, 18, A.bch, EVM],
  ['dash-eth', 'dash', 1, 'dash', NATIVE_EVM, 8, 18, A.dash, EVM],
  ['zec-eth', 'zcash', 1, 'zcash', NATIVE_EVM, 8, 18, A.zec, EVM],
  ['ton-eth', 'ton', 1, 'ton', NATIVE_EVM, 9, 18, A.ton, EVM],
  ['sui-eth', 'sui', 1, 'sui', NATIVE_EVM, 9, 18, A.sui, EVM],
  ['apt-eth', 'aptos', 1, 'aptos', NATIVE_EVM, 8, 18, A.apt, EVM],
  ['arbeth-xlm', 42_161, 'stellar', NATIVE_EVM, 'stellar', 18, 7, EVM, A.xlm],
  ['xdai-bch', 100, 'bitcoincash', NATIVE_EVM, 'bitcoincash', 18, 8, EVM, A.bch],
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

describe('1Click chain keys', () => {
  it('maps the new chains to their 1Click blockchain, Stellar arrival only', () => {
    expect(['bitcoincash', 'dash', 'zcash', 'sui', 'ton', 'aptos', 'stellar', '100'].map((c) => ONE_CLICK_CHAINS[c])).toEqual(['bch', 'dash', 'zec', 'sui', 'ton', 'aptos', 'stellar', 'gnosis']);
    expect(ONE_CLICK_ARRIVAL_ONLY.has('stellar')).toBe(true);
    // Live: 1Click refuses a SIMPLE deposit from Stellar (it wants a memo Kyro never sends).
    expect(FIX.xlmOrigin.http).toBe(400);
    expect(FIX.xlmOrigin.message).toMatch(/depositMode/);
    // Hex addresses (EVM, Sui, Aptos) compare in any case; the others exactly.
    expect(sameChainAddress('sui', A.sui.toUpperCase().replace('0X', '0x'), A.sui)).toBe(true);
    expect(sameChainAddress('aptos', A.apt.toUpperCase().replace('0X', '0x'), A.apt)).toBe(true);
    expect(sameChainAddress('ton', A.ton.toLowerCase(), A.ton)).toBe(false);
    expect(sameChainAddress('bitcoincash', A.bch.toUpperCase(), A.bch)).toBe(false);
  });

  it('who quotes what: 1Click from the new chains and to them, never from Stellar; LI.FI keeps EVM ↔ Gnosis', () => {
    const near = new NearIntentsProvider({ fee: { kind: 'fee', bps: 70, recipient: EVM } });
    const lifi = new LifiProvider({ fee: { kind: 'fee', bps: 70, recipient: EVM } });
    for (const name of ['bch-eth', 'dash-eth', 'zec-eth', 'ton-eth', 'sui-eth', 'apt-eth', 'arbeth-xlm', 'xdai-bch']) {
      const { params } = setup(name);
      expect(near.supports(params), name).toBe(true);
      expect(lifi.supports(params), name).toBe(false);
    }
    const p = setup('arbeth-xlm').params;
    expect(near.supports({ ...p, chain: 'stellar', toChain: 42_161, recipient: EVM, taker: A.xlm })).toBe(false);
    // EVM → Gnosis: LI.FI (NEAR Intents facet), not 1Click directly.
    expect(near.supports({ ...p, toChain: 100, recipient: EVM })).toBe(false);
    expect(lifi.supports({ ...p, toChain: 100, recipient: EVM })).toBe(true);
    // Chains 1Click does not serve in Kyro: no route.
    expect(near.supports({ ...p, toChain: 25, recipient: EVM })).toBe(false);
  });
});

describe('real answers accepted', () => {
  it.each(ROUTES.map((r) => r[0]))('%s: our recipient and refund, our fee echoed, SIMPLE deposit, confirmed by /v0/status', (name) => {
    const s = setup(name);
    expect(s.expect.originAsset).not.toBe('');
    expect(s.expect.destinationAsset).not.toBe('');
    const c = checkOneClickQuote(s.f.quote, s.expect);
    expect(c).toMatchObject({ depositAddress: s.depositAddress, kyroFeeBps: 70, oneClickFeeBps: 70 });
    const n = checkNearDeposit(s.f.status, TOKENS, depositExpect(s));
    expect(n).toMatchObject({ kyroFeeBps: 70, otherFeeBps: 70, minAmountOut: c.minAmountOut });
    expect(n.deadline).toBe(Date.parse(s.f.quote.quoteRequest?.deadline ?? ''));
  });
});

describe('refused, never signed', () => {
  const req = (q: OneClickQuoteAnswer) => q.quoteRequest as NonNullable<OneClickQuoteAnswer['quoteRequest']>;
  const quote = (q: OneClickQuoteAnswer) => q.quote as NonNullable<OneClickQuoteAnswer['quote']>;

  it.each(['bch-eth', 'zec-eth', 'ton-eth', 'sui-eth', 'arbeth-xlm'])('%s: another recipient / refund, a memo, a fee taken elsewhere, the deposit = our address', (name) => {
    const s = setup(name);
    const refuse = (edit: (q: OneClickQuoteAnswer) => void, why: RegExp) => {
      const q = clone(s.f.quote);
      edit(q);
      expect(() => checkOneClickQuote(q, s.expect)).toThrow(why);
    };
    refuse((q) => (req(q).appFees = [{ recipient: '0xbad0000000000000000000000000000000000bad', fee: 70 }, { recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 70 }]), /frais Kyro absents/);
    refuse((q) => (req(q).recipient = name === 'arbeth-xlm' ? 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ' : '0xbad0000000000000000000000000000000000bad'), /destinataire/);
    refuse((q) => (req(q).refundTo = name === 'ton-eth' ? 'EQCKhieGGl3ZbJ2zzggHsSLaXtRzk0znVopbSxw2HLsorkdl' : name === 'sui-eth' ? '0x' + '1'.repeat(64) : name === 'zec-eth' ? 't1WWJ7Mv4R5mk4hbmzh7nBGjfhF38N6fcFp' : name === 'bch-eth' ? 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy' : '0xbad0000000000000000000000000000000000bad'), /remboursement/);
    refuse((q) => (quote(q).depositMemo = '12345'), /mémo/);
    refuse((q) => (req(q).depositMode = 'MEMO'), /mémo/);
    refuse((q) => (quote(q).depositAddress = s.expect.refundTo), /ta propre adresse/);
    // /v0/status of the deposit address: a refund elsewhere or a used address is refused too.
    const st = clone(s.f.status);
    (st.quoteResponse?.quoteRequest as { refundTo?: string }).refundTo = 'someone-else';
    expect(() => checkNearDeposit(st, TOKENS, depositExpect(s))).toThrow(/remboursement/);
    expect(() => checkNearDeposit({ ...clone(s.f.status), status: 'SUCCESS' }, TOKENS, depositExpect(s))).toThrow(/déjà utilisée/);
  });

  it('a TON deposit address in another form, or a Sui one in another case, is the same account only for hex chains', () => {
    const sui = setup('sui-eth');
    expect(checkNearDeposit(sui.f.status, TOKENS, depositExpect(sui, { depositAddress: sui.depositAddress.toUpperCase().replace('0X', '0x') })).kyroFeeBps).toBe(70);
    const ton = setup('ton-eth');
    expect(() => checkNearDeposit(ton.f.status, TOKENS, depositExpect(ton, { depositAddress: ton.depositAddress.toLowerCase() }))).toThrow(/adresse de dépôt différente/);
  });
});
