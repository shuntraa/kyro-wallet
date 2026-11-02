// SPDX-License-Identifier: GPL-3.0-or-later
//
// Exolix public API v2 (exolix.com/api/v2, no key) for Monero, which NEAR Intents does not list.
// Like 1Click: Exolix binds a deposit address to our withdrawal address; we check the order it
// created (amount, coins, our own withdrawal / refund address, deposit address format) and send an
// ordinary transfer there. No affiliate program: Kyro's fee is taken on the SOURCE side — the
// amount swapped is reduced by the fee, which goes in a second ordinary transfer of the same coin to
// Kyro's fee address on that chain (`DepositPlan.kyroFee`). No fee address on a chain → no route.

import { isAddress } from 'viem';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { sha256 } from 'viem';
import { fetchJson, l10n, netFetch, type NetFetch } from '@kyro/shared';
import type { DepositPlan, Quote, QuoteParams, SwapChain, SwapProvider } from '../types';
import { feeForQuote, validFeeAddress, validSolanaAddress, type ProviderFee } from '../fees';
import { applySlippage } from '../compare';
import { SwapCheckError } from '../verify';
import { isNative, providerError } from './common';

export const EXOLIX_HOST = 'exolix.com';
const API = `https://${EXOLIX_HOST}/api/v2`;

const WSOL = 'So11111111111111111111111111111111111111112';

/** Kyro asset (chain + token id as `swapTokenAddress` gives it) → Exolix coin / network. */
export interface ExolixAsset {
  chain: SwapChain;
  /** Native: the chain name (`monero`, `bitcoin`, `litecoin`), `0xEeee…` (EVM) or the wSOL mint; token: contract / mint. */
  token: string | null;
  coin: string;
  network: string;
  decimals: number;
}

export const EXOLIX_ASSETS: readonly ExolixAsset[] = [
  { chain: 'monero', token: null, coin: 'XMR', network: 'XMR', decimals: 12 },
  { chain: 'bitcoin', token: null, coin: 'BTC', network: 'BTC', decimals: 8 },
  { chain: 'litecoin', token: null, coin: 'LTC', network: 'LTC', decimals: 8 },
  { chain: 1, token: null, coin: 'ETH', network: 'ETH', decimals: 18 },
  { chain: 1, token: '0xdac17f958d2ee523a2206206994597c13d831ec7', coin: 'USDT', network: 'ETH', decimals: 6 },
  { chain: 1, token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', coin: 'USDC', network: 'ETH', decimals: 6 },
  { chain: 'solana', token: null, coin: 'SOL', network: 'SOL', decimals: 9 },
  { chain: 'solana', token: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', coin: 'USDT', network: 'SOL', decimals: 6 },
  { chain: 'solana', token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', coin: 'USDC', network: 'SOL', decimals: 6 },
];

/** Chains Exolix serves in Kyro (one side of every Exolix route is Monero). */
export const EXOLIX_CHAINS: ReadonlySet<SwapChain> = new Set(EXOLIX_ASSETS.map((a) => a.chain));

const nativeOf = (chain: SwapChain, token: string) => (chain === 'solana' ? token === WSOL || token === '11111111111111111111111111111111' : typeof chain === 'string' ? token === chain : isNative(token));

export function exolixAsset(chain: SwapChain, token: string, decimals: number): ExolixAsset | null {
  const native = nativeOf(chain, token);
  const a = EXOLIX_ASSETS.find((x) => x.chain === chain && (native ? x.token === null : x.token !== null && x.token.toLowerCase() === token.toLowerCase()));
  return a && a.decimals === decimals ? a : null;
}

const XMR_ALPHABET = /^[1-9A-HJ-NP-Za-km-z]+$/;
const b58check = createBase58check((d) => sha256(d, 'bytes'));
const legacy = (a: string, versions: number[]) => {
  try {
    const raw = b58check.decode(a);
    return raw.length === 21 && versions.includes(raw[0] as number);
  } catch {
    return false;
  }
};
const segwitAny = (a: string, hrp: string) => {
  if (a.toLowerCase() !== a) return false;
  try {
    const d = a.startsWith(`${hrp}1p`) ? bech32m.decode(a as `${string}1${string}`) : bech32.decode(a as `${string}1${string}`);
    return d.prefix === hrp;
  } catch {
    return false;
  }
};

/** Mainnet address shape (with checksum where cheap) of `chain`: the deposit address Exolix returns must pass it. */
export function validChainAddress(chain: SwapChain, a: string): boolean {
  if (!a || a.trim() !== a) return false;
  if (typeof chain === 'number') return isAddress(a, { strict: false });
  switch (chain) {
    case 'monero':
      return XMR_ALPHABET.test(a) && ((a.length === 95 && (a[0] === '4' || a[0] === '8')) || (a.length === 106 && a[0] === '4'));
    case 'bitcoin':
      return legacy(a, [0x00, 0x05]) || segwitAny(a, 'bc');
    case 'litecoin':
      return validFeeAddress('litecoin', a) || legacy(a, [0x05]) || segwitAny(a, 'ltc');
    case 'solana':
      return validSolanaAddress(a);
    default:
      return false;
  }
}

const sameAddr = (chain: SwapChain, a: string | undefined | null, b: string) => !!a && (typeof chain === 'number' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Base units → Exolix decimal string, and back (exact, no float). */
export function toDecimal(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}
export function fromDecimal(v: unknown, decimals: number): bigint | null {
  const s = typeof v === 'number' && Number.isFinite(v) ? v.toFixed(decimals) : typeof v === 'string' ? v.trim() : '';
  const m = /^(\d{1,30})(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(m[1] as string) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

export interface ExolixRate {
  fromAmount?: number | string;
  toAmount?: number | string;
  rate?: number | string;
  minAmount?: number | string;
  maxAmount?: number | string;
  message?: string | null;
}

export interface ExolixCoin {
  coinCode?: string;
  network?: string;
}

export interface ExolixTx {
  id?: string;
  amount?: number | string;
  amountTo?: number | string;
  coinFrom?: ExolixCoin;
  coinTo?: ExolixCoin;
  depositAddress?: string;
  depositExtraId?: string | null;
  withdrawalAddress?: string;
  withdrawalExtraId?: string | null;
  refundAddress?: string | null;
  refundExtraId?: string | null;
  rateType?: string;
  status?: string;
  hashOut?: { hash?: string | null } | null;
  message?: string;
}

export interface ExolixExpect {
  from: ExolixAsset;
  to: ExolixAsset;
  /** Amount swapped (after Kyro's fee), base units of `from`. */
  amountIn: bigint;
  recipient: string;
  refundTo: string;
  /** Least amount Kyro accepts on arrival (what it shows as the minimum). */
  minAmountOut: bigint;
  rateType: 'fixed' | 'float';
}

const fail = (why: string): never => {
  throw new SwapCheckError(l10n(`Exolix : ${why} — devis refusé, rien n’a été signé.`, `Exolix: ${why} — quote refused, nothing was signed.`));
};

/** Checks an Exolix order (create answer or `/transactions/{id}`) against what Kyro asked. Throws `SwapCheckError`. */
export function checkExolixTx(t: ExolixTx, e: ExolixExpect): { id: string; depositAddress: string; amountOut: bigint } {
  if (!t.id || typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(t.id)) return fail(t.message ? l10n(`pas d’ordre (${t.message})`, `no order (${t.message})`) : l10n('réponse illisible', 'unreadable response'));
  if (t.coinFrom?.coinCode !== e.from.coin || t.coinFrom?.network !== e.from.network || t.coinTo?.coinCode !== e.to.coin || t.coinTo?.network !== e.to.network) fail(l10n('monnaies de l’ordre différentes de celles demandées', 'order coins differ from the requested ones'));
  if (!sameAddr(e.to.chain, t.withdrawalAddress, e.recipient) || t.withdrawalExtraId) fail(l10n(`destinataire ${t.withdrawalAddress ?? '?'} au lieu de ton adresse`, `recipient ${t.withdrawalAddress ?? '?'} instead of your address`));
  if (t.refundAddress && !sameAddr(e.from.chain, t.refundAddress, e.refundTo)) fail(l10n('remboursement prévu vers une autre adresse que la tienne', 'refund planned to an address other than yours'));
  if (fromDecimal(t.amount, e.from.decimals) !== e.amountIn) fail(l10n('montant différent de ta saisie', 'amount differs from what you entered'));
  if (t.rateType && t.rateType !== e.rateType) fail(l10n('type de taux inattendu', 'unexpected rate type'));
  const dep = t.depositAddress ?? '';
  if (t.depositExtraId) fail(l10n('dépôt avec mémo / tag demandé (Kyro n’envoie qu’un transfert simple)', 'deposit with memo / tag requested (Kyro only sends a plain transfer)'));
  if (!validChainAddress(e.from.chain, dep)) fail(l10n('adresse de dépôt invalide pour cette chaîne', 'deposit address invalid for this chain'));
  if (sameAddr(e.from.chain, dep, e.refundTo)) fail(l10n('adresse de dépôt = ta propre adresse', 'deposit address = your own address'));
  if (t.status && t.status !== 'wait') fail(l10n(`ordre déjà utilisé ou expiré (${t.status})`, `order already used or expired (${t.status})`));
  const out = fromDecimal(t.amountTo, e.to.decimals);
  if (out === null || out <= 0n || out < e.minAmountOut) fail(l10n('montant reçu plus bas que le minimum affiché', 'received amount lower than the minimum shown'));
  return { id: t.id, depositAddress: dep, amountOut: out as bigint };
}

/** Kyro fee recipient per source chain (the second transfer of the source coin goes there). */
export type ExolixFeeRecipients = Partial<Record<'evm' | 'solana' | 'bitcoin' | 'litecoin' | 'monero', string>>;
const feeKey = (c: SwapChain): keyof ExolixFeeRecipients | null => (typeof c === 'number' ? 'evm' : c === 'solana' || c === 'bitcoin' || c === 'litecoin' || c === 'monero' ? c : null);

/** Splits what the user sends: the swapped part and Kyro's fee (rounded up, never 0 when a rate applies). */
export function exolixFeeSplit(sellAmount: bigint, bps: number): { swapped: bigint; fee: bigint } {
  if (bps <= 0) return { swapped: sellAmount, fee: 0n };
  const fee = (sellAmount * BigInt(bps) + 9_999n) / 10_000n;
  return { swapped: sellAmount - fee, fee };
}

export class ExolixProvider implements SwapProvider {
  readonly id = 'exolix' as const;
  readonly name = 'Exolix';
  readonly host = EXOLIX_HOST;
  private readonly fetcher: NetFetch;

  constructor(private readonly opts: { fetch?: NetFetch; fee: ProviderFee; recipients: ExolixFeeRecipients }) {
    this.fetcher = opts.fetch ?? netFetch;
  }

  available(): boolean {
    return this.unavailableReason() === null;
  }

  unavailableReason(): string | null {
    return this.opts.fee.kind === 'unavailable' ? this.opts.fee.reason : null;
  }

  /** Monero on one side, a mapped Exolix asset on the other. */
  supports(p: QuoteParams): boolean {
    const to = p.toChain ?? p.chain;
    if (p.chain === to || (p.chain !== 'monero' && to !== 'monero')) return false;
    return exolixAsset(p.chain, p.sell.address, p.sell.decimals) !== null && exolixAsset(to, p.buy.address, p.buy.decimals) !== null;
  }

  /** Kyro fee of this quote: the curve's rate, paid to Kyro's address on the source chain. */
  private fee(p: QuoteParams): { bps: number; recipient: string } | null {
    const f = feeForQuote(this.opts.fee, p);
    if (f.kind === 'unavailable') throw new Error(f.reason);
    if (f.kind !== 'fee') return null;
    const key = feeKey(p.chain);
    const r = key ? this.opts.recipients[key] : undefined;
    if (!r || !validChainAddress(p.chain, r)) throw new Error(l10n('Exolix : adresse des frais Kyro non configurée sur cette chaîne', 'Exolix: Kyro fee address not configured on this chain'));
    return { bps: f.bps, recipient: r };
  }

  private async rate(from: ExolixAsset, to: ExolixAsset, amount: bigint, rateType: 'fixed' | 'float'): Promise<ExolixRate> {
    const q = new URLSearchParams({ coinFrom: from.coin, networkFrom: from.network, coinTo: to.coin, networkTo: to.network, amount: toDecimal(amount, from.decimals), rateType });
    return fetchJson<ExolixRate>(this.fetcher, `${API}/rate?${q.toString()}`);
  }

  async quote(p: QuoteParams): Promise<Quote> {
    if (!this.supports(p)) throw new Error(l10n('Exolix : route non prise en charge', 'Exolix: route not supported'));
    const toChain = p.toChain ?? p.chain;
    const recipient = p.recipient ?? '';
    if (!recipient || !validChainAddress(toChain, recipient)) throw new Error(l10n('Exolix : pas de compte à toi sur la chaîne de destination', 'Exolix: no account of yours on the destination chain'));
    const from = exolixAsset(p.chain, p.sell.address, p.sell.decimals) as ExolixAsset;
    const to = exolixAsset(toChain, p.buy.address, p.buy.decimals) as ExolixAsset;
    const fee = this.fee(p);
    const { swapped, fee: feeAmount } = exolixFeeSplit(p.sellAmount, fee?.bps ?? 0);
    let rateType: 'fixed' | 'float' = 'fixed';
    let r: ExolixRate;
    try {
      r = await this.rate(from, to, swapped, 'fixed');
      if (fromDecimal(r.toAmount, to.decimals) === null || (fromDecimal(r.toAmount, to.decimals) ?? 0n) <= 0n) {
        rateType = 'float';
        r = await this.rate(from, to, swapped, 'float');
      }
    } catch (e) {
      throw providerError(this.name, e);
    }
    const c = parseExolixRate(r, from, to, swapped);
    const minOut = rateType === 'fixed' ? c.amountOut : applySlippage(c.amountOut, p.slippageBps);
    const expect: ExolixExpect = { from, to, amountIn: swapped, recipient, refundTo: p.taker, minAmountOut: minOut, rateType };
    const plan = (id: string, depositAddress: string, amountOut: bigint): DepositPlan => ({
      depositAddress,
      amountIn: swapped,
      amountOut,
      minAmountOut: rateType === 'fixed' ? amountOut : minOut,
      deadline: Date.now() + 3_600_000,
      kyroFeeBps: fee?.bps ?? 0,
      oneClickFeeBps: 0,
      timeEstimateSecs: null,
      orderId: id,
      ...(fee && feeAmount > 0n ? { kyroFee: { recipient: fee.recipient, amount: feeAmount } } : {}),
    });
    const prepare = async (): Promise<DepositPlan> => {
      const body = { coinFrom: from.coin, networkFrom: from.network, coinTo: to.coin, networkTo: to.network, amount: toDecimal(swapped, from.decimals), withdrawalAddress: recipient, refundAddress: p.taker, rateType };
      let t: ExolixTx;
      try {
        t = await fetchJson<ExolixTx>(this.fetcher, `${API}/transactions`, { method: 'POST', body });
      } catch (e) {
        throw providerError(this.name, e);
      }
      const k = checkExolixTx(t, expect);
      return plan(k.id, k.depositAddress, k.amountOut);
    };
    const reconfirm = async (old: DepositPlan): Promise<DepositPlan> => {
      let t: ExolixTx;
      try {
        t = await exolixOrder(this.fetcher, old.orderId ?? '');
      } catch (e) {
        return fail(l10n(`confirmation impossible (${e instanceof Error ? e.message : String(e)})`, `confirmation impossible (${e instanceof Error ? e.message : String(e)})`));
      }
      const k = checkExolixTx(t, { ...expect, minAmountOut: old.minAmountOut });
      if (k.depositAddress !== old.depositAddress) fail(l10n('adresse de dépôt changée', 'deposit address changed'));
      return { ...plan(k.id, k.depositAddress, k.amountOut), deadline: old.deadline };
    };
    return {
      provider: this.id,
      providerName: this.name,
      buyAmount: c.amountOut,
      minBuyAmount: minOut,
      gasFeeFiat: null,
      providerFeeFiat: null,
      providerFeeIncluded: true,
      kyroFeeBps: fee?.bps ?? 0,
      priceImpact: null,
      allowanceTarget: null,
      tx: { kind: 'deposit', chain: p.chain, prepare, reconfirm },
      cross: { fromChain: p.chain, toChain, recipient, bridge: 'exolix', bridgeName: this.name },
      route: `via ${this.name}${rateType === 'float' ? ' (float)' : ''}`,
    };
  }
}

/** Reads an Exolix `/rate` answer for `amount` of `from`. Throws `SwapCheckError`. */
export function parseExolixRate(r: ExolixRate, from: ExolixAsset, to: ExolixAsset, amount: bigint): { amountOut: bigint } {
  const out = fromDecimal(r.toAmount, to.decimals);
  if (out === null || out <= 0n) return fail(r.message ? l10n(`pas de devis (${r.message})`, `no quote (${r.message})`) : l10n('réponse illisible', 'unreadable response'));
  const fromAmount = fromDecimal(r.fromAmount, from.decimals);
  if (fromAmount !== null && fromAmount !== amount) fail(l10n('montant du devis différent de ta saisie', 'quoted amount differs from what you entered'));
  const min = fromDecimal(r.minAmount, from.decimals);
  if (min !== null && amount < min) fail(l10n(`montant sous le minimum d’Exolix (${String(r.minAmount)})`, `amount below Exolix's minimum (${String(r.minAmount)})`));
  return { amountOut: out };
}

export function exolixOrder(fetcher: NetFetch, id: string): Promise<ExolixTx> {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new Error(l10n('Exolix : identifiant d’ordre invalide', 'Exolix: invalid order id'));
  return fetchJson<ExolixTx>(fetcher, `${API}/transactions/${id}`);
}

/** History status: Exolix's `status` mapped to 1Click's vocabulary (SUCCESS, REFUNDED, FAILED, in progress). */
export async function exolixOrderStatus(fetcher: NetFetch, id: string): Promise<{ status: string; destinationTxHash?: string }> {
  const t = await exolixOrder(fetcher, id);
  const s = t.status ?? '';
  const status = s === 'success' ? 'SUCCESS' : s === 'refunded' ? 'REFUNDED' : s === 'overdue' ? 'FAILED' : 'PROCESSING';
  const hash = t.hashOut?.hash;
  return { status, ...(hash ? { destinationTxHash: hash } : {}) };
}
