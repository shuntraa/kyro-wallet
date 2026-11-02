// Exolix (providers/exolix.ts): asset mapping, source-side Kyro fee, order checks and answer parsing
// against answers recorded over Tor (fixtures/exolix/*.json, nothing deposited).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NetFetch } from '@kyro/shared';
import {
  checkExolixTx,
  createProviders,
  EXOLIX_ASSETS,
  ExolixProvider,
  exolixAsset,
  exolixFeeRecipients,
  exolixFeeSplit,
  fromDecimal,
  KYRO_SWAP_FEE,
  NATIVE_EVM,
  parseExolixRate,
  providerFee,
  SwapCheckError,
  toDecimal,
  validChainAddress,
  WSOL_MINT,
  type ExolixAsset,
  type ExolixRate,
  type ExolixTx,
  type QuoteParams,
} from '../src';

const fix = <T>(n: string): T => JSON.parse(readFileSync(new URL(`./fixtures/exolix/${n}.json`, import.meta.url), 'utf8')) as T;
const RATE = fix<{ fixed: ExolixRate; float: ExolixRate; request: { amount: string } }>('rate-xmr-btc');
const CREATE = fix<{ request: { withdrawalAddress: string; amount: string }; response: ExolixTx }>('create-xmr-btc');

const XMR = exolixAsset('monero', 'monero', 12) as ExolixAsset;
const BTC = exolixAsset('bitcoin', 'bitcoin', 8) as ExolixAsset;
const OWN_XMR = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const OTHER_XMR = `${OWN_XMR.slice(0, 94)}B`;
const OWN_BTC = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const THIEF_BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

describe('Exolix asset mapping', () => {
  it('maps natives and USDT / USDC, refuses unknown tokens or wrong decimals', () => {
    expect(XMR.coin).toBe('XMR');
    expect(exolixAsset(1, NATIVE_EVM, 18)?.coin).toBe('ETH');
    expect(exolixAsset(1, '0xDAC17F958D2EE523A2206206994597C13D831EC7', 6)).toMatchObject({ coin: 'USDT', network: 'ETH' });
    expect(exolixAsset('solana', WSOL_MINT, 9)?.coin).toBe('SOL');
    expect(exolixAsset('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6)).toMatchObject({ coin: 'USDC', network: 'SOL' });
    expect(exolixAsset('monero', 'monero', 8)).toBeNull();
    expect(exolixAsset(1, '0x0000000000000000000000000000000000000001', 18)).toBeNull();
    expect(new Set(EXOLIX_ASSETS.map((a) => `${a.coin}/${a.network}`)).size).toBe(EXOLIX_ASSETS.length);
  });

  it('decimal strings round-trip exactly', () => {
    expect(toDecimal(1_234_500_000_000n, 12)).toBe('1.2345');
    expect(toDecimal(5n, 8)).toBe('0.00000005');
    expect(fromDecimal('0.00000005', 8)).toBe(5n);
    expect(fromDecimal(0.00768269, 8)).toBe(768_269n);
    expect(fromDecimal(1, 12)).toBe(10n ** 12n);
    expect(fromDecimal('1e-8', 8)).toBeNull();
    expect(fromDecimal('-1', 8)).toBeNull();
  });
});

describe('Exolix Kyro fee (source side)', () => {
  it('splits what the user sends into swapped + fee, rounded up', () => {
    expect(exolixFeeSplit(1_000_000n, 90)).toEqual({ swapped: 991_000n, fee: 9_000n });
    expect(exolixFeeSplit(1n, 70)).toEqual({ swapped: 0n, fee: 1n });
    expect(exolixFeeSplit(1_000n, 0)).toEqual({ swapped: 1_000n, fee: 0n });
  });

  it('uses the existing fee addresses, and no Monero source without a valid Monero fee address', () => {
    const r = exolixFeeRecipients(KYRO_SWAP_FEE);
    expect(r.bitcoin).toBe(KYRO_SWAP_FEE.recipients.bitcoin);
    expect(r.litecoin).toBe(KYRO_SWAP_FEE.recipients.litecoin);
    expect(r.evm).toBe(KYRO_SWAP_FEE.recipients.evm);
    expect(r.monero).toBeUndefined();
    expect(exolixFeeRecipients({ ...KYRO_SWAP_FEE, recipients: { ...KYRO_SWAP_FEE.recipients, monero: 'nope' } }).monero).toBeUndefined();
    expect(exolixFeeRecipients({ ...KYRO_SWAP_FEE, recipients: { ...KYRO_SWAP_FEE.recipients, monero: OWN_XMR } }).monero).toBe(OWN_XMR);
  });

  it('quotes the amount after fee and plans the fee transfer to Kyro', async () => {
    const seen: string[] = [];
    const fetch: NetFetch = async (req) => {
      seen.push(req.url);
      if (req.url.includes('/rate?')) return { status: 200, body: JSON.stringify({ ...RATE.fixed, minAmount: 0.0001, fromAmount: Number(new URL(req.url).searchParams.get('amount')) }) };
      const b = JSON.parse(String(req.body ?? '{}')) as { amount: string; withdrawalAddress: string; refundAddress: string };
      const answer = { ...CREATE.response, amount: Number(b.amount), withdrawalAddress: b.withdrawalAddress, refundAddress: b.refundAddress, coinFrom: { coinCode: 'BTC', network: 'BTC' }, coinTo: { coinCode: 'XMR', network: 'XMR' }, depositAddress: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', amountTo: RATE.fixed.toAmount };
      return { status: 201, body: JSON.stringify(answer) };
    };
    const p = new ExolixProvider({ fetch, fee: providerFee('exolix', KYRO_SWAP_FEE), recipients: exolixFeeRecipients(KYRO_SWAP_FEE) });
    const params: QuoteParams = { chain: 'bitcoin', toChain: 'monero', recipient: OWN_XMR, sell: { address: 'bitcoin', symbol: 'BTC', decimals: 8 }, buy: { address: 'monero', symbol: 'XMR', decimals: 12 }, sellAmount: 1_000_000n, taker: OWN_BTC, slippageBps: 100 };
    expect(p.supports(params)).toBe(true);
    const q = await p.quote(params);
    expect(q.kyroFeeBps).toBe(90);
    expect(seen[0]).toContain('amount=0.00991');
    if (q.tx.kind !== 'deposit') throw new Error('kind');
    const plan = await q.tx.prepare();
    expect(plan.amountIn).toBe(991_000n);
    expect(plan.kyroFee).toEqual({ recipient: KYRO_SWAP_FEE.recipients.bitcoin, amount: 9_000n });
    expect(plan.orderId).toBe(CREATE.response.id);
    // Monero source: no Kyro fee address on Monero → no quote (never fee-free).
    await expect(p.quote({ ...params, chain: 'monero', toChain: 'bitcoin', recipient: OWN_BTC, taker: OWN_XMR, sell: params.buy, buy: params.sell, sellAmount: 10n ** 12n })).rejects.toThrow(/fee address|adresse des frais/);
  });

  it('is registered with the other providers, for Monero pairs only', () => {
    const ex = createProviders({ hasZeroxKey: () => false }).find((x) => x.id === 'exolix');
    expect(ex).toBeDefined();
    const base: QuoteParams = { chain: 'bitcoin', toChain: 1, recipient: '0x86cD9af8067fF5e0001c709a550cD62b5e968B44', sell: { address: 'bitcoin', symbol: 'BTC', decimals: 8 }, buy: { address: NATIVE_EVM, symbol: 'ETH', decimals: 18 }, sellAmount: 1n, taker: OWN_BTC, slippageBps: 50 };
    expect(ex?.supports(base)).toBe(false);
    expect(ex?.supports({ ...base, toChain: 'monero', recipient: OWN_XMR, buy: { address: 'monero', symbol: 'XMR', decimals: 12 } })).toBe(true);
  });
});

describe('Exolix answers (recorded over Tor)', () => {
  const amountIn = fromDecimal(CREATE.request.amount, 12) as bigint;
  const ok = { from: XMR, to: BTC, amountIn, recipient: CREATE.request.withdrawalAddress, refundTo: OWN_XMR, minAmountOut: 1n, rateType: 'fixed' as const };
  const t = CREATE.response;

  it('reads a /rate answer, refuses an error message or a too-small amount', () => {
    expect(parseExolixRate(RATE.fixed, XMR, BTC, 10n ** 12n).amountOut).toBe(768_153n);
    expect(() => parseExolixRate({ message: 'Amount to exchange is below the possible min amount to exchange' }, XMR, BTC, 1n)).toThrow(SwapCheckError);
    expect(() => parseExolixRate({ ...RATE.fixed, fromAmount: 0.01 }, XMR, BTC, 10n ** 10n)).toThrow(/minimum|min/);
    expect(() => parseExolixRate(RATE.fixed, XMR, BTC, 2n * 10n ** 12n)).toThrow(SwapCheckError);
  });

  it('accepts the recorded order', () => {
    const r = checkExolixTx(t, ok);
    expect(r).toEqual({ id: '5023b15f2ce4fc', depositAddress: t.depositAddress, amountOut: 768_269n });
    expect(checkExolixTx({ ...t, refundAddress: OWN_XMR }, ok).id).toBe(t.id);
  });

  it('rejects a wrong recipient or refund, a bad deposit address, a memo, another amount, coin or state', () => {
    expect(() => checkExolixTx({ ...t, withdrawalAddress: THIEF_BTC }, ok)).toThrow(/recipient|destinataire/);
    expect(() => checkExolixTx({ ...t, refundAddress: OTHER_XMR }, ok)).toThrow(/refund|rembours/);
    expect(() => checkExolixTx({ ...t, depositAddress: THIEF_BTC }, ok)).toThrow(/deposit address|adresse de dépôt/);
    expect(() => checkExolixTx({ ...t, depositAddress: `${String(t.depositAddress)}x` }, ok)).toThrow(SwapCheckError);
    expect(() => checkExolixTx({ ...t, depositAddress: OWN_XMR }, ok)).toThrow(/own address|propre adresse/);
    expect(() => checkExolixTx({ ...t, depositExtraId: '123' }, ok)).toThrow(SwapCheckError);
    expect(() => checkExolixTx({ ...t, amount: 2 }, ok)).toThrow(/amount|montant/);
    expect(() => checkExolixTx({ ...t, coinTo: { coinCode: 'LTC', network: 'LTC' } }, ok)).toThrow(SwapCheckError);
    expect(() => checkExolixTx({ ...t, rateType: 'float' }, ok)).toThrow(SwapCheckError);
    expect(() => checkExolixTx(t, { ...ok, minAmountOut: 10n ** 9n })).toThrow(/minimum/);
    expect(() => checkExolixTx({ ...t, status: 'success' }, ok)).toThrow(SwapCheckError);
    expect(() => checkExolixTx({ message: 'error' }, ok)).toThrow(SwapCheckError);
  });

  it('validates deposit address formats per source chain', () => {
    expect(validChainAddress('bitcoin', OWN_BTC)).toBe(true);
    expect(validChainAddress('bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true);
    expect(validChainAddress('bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb')).toBe(false);
    expect(validChainAddress('litecoin', 'LWePW8iwa8RxxYB6av4KBriBNkRgLWvNyw')).toBe(true);
    expect(validChainAddress('litecoin', OWN_BTC)).toBe(false);
    expect(validChainAddress(1, '0x86cD9af8067fF5e0001c709a550cD62b5e968B44')).toBe(true);
    expect(validChainAddress('solana', 'ptsbLdrhmEfC2eQ9gj4aieF4irdhQqYzK1fdNwHBZcM')).toBe(true);
    expect(validChainAddress('monero', String(t.depositAddress))).toBe(true);
    expect(validChainAddress('monero', OWN_XMR.slice(0, 94))).toBe(false);
    expect(validChainAddress('monero', ` ${OWN_XMR}`)).toBe(false);
  });
});
