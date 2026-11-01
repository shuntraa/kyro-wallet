// SPDX-License-Identifier: GPL-3.0-or-later
//
// NEAR Intents 1Click used directly for routes LI.FI cannot serve (docs.near-intents.org "1Click API").
// No third-party tx: 1Click binds a one-time deposit address to our recipient/refund/amount/minimum,
// we check it twice (quote, then `/v0/status`) and send an ordinary transfer there.
// Fee: `appFees`, split 50/50 by 1Click, so we request twice our rate and demand exactly `bps` back.

import { fetchJson, l10n, netFetch, type NetFetch } from '@kyro/shared';
import type { DepositPlan, Quote, QuoteParams, SwapChain, SwapProvider } from '../types';
import { ONE_CLICK_FEE_REQUEST_FACTOR, ONE_CLICK_MAX_TOTAL_BPS, feeForQuote, type ProviderFee } from '../fees';
import { providerError } from './common';
import { applySlippage } from '../compare';
import { SwapCheckError } from '../verify';
import { NEAR_INTENTS_HOST, NearIntentsClient, ONE_CLICK_ARRIVAL_ONLY, ONE_CLICK_CHAINS, checkAppFees, oneClickAssetIs, sameChainAddress, type OneClickStatus, type OneClickToken } from '../near-intents';

export interface OneClickQuoteAnswer {
  quoteRequest?: NonNullable<OneClickStatus['quoteResponse']>['quoteRequest'] & { dry?: boolean };
  quote?: NonNullable<NonNullable<OneClickStatus['quoteResponse']>['quote']>;
  message?: string;
}

export interface NearFee {
  /** What Kyro must be paid (bps) and where (NEAR Intents account, lower case). */
  bps: number;
  recipient: string;
  /** `appFees[0].fee` sent to 1Click (twice `bps`: 1Click keeps half). */
  requestBps: number;
}

/** Deposit must be seen by 1Click well before its deadline (Bitcoin can take an hour to confirm). */
export const NEAR_MIN_TIME_LEFT_MS = 2 * 3_600_000;
/** Chains LI.FI serves as source (EVM, Solana) and destinations it reaches from there. */
const lifiSource = (c: SwapChain) => typeof c === 'number' || c === 'solana';
const lifiDestination = (c: SwapChain) => lifiSource(c) || c === 'bitcoin';

const fail = (why: string): never => {
  throw new SwapCheckError(l10n(`NEAR Intents : ${why} — devis refusé, rien n’a été signé.`, `NEAR Intents: ${why} — quote refused, nothing was signed.`));
};
const sameAddr = sameChainAddress;
const big = (v: string | undefined): bigint | null => (v !== undefined && /^\d{1,78}$/.test(v) ? BigInt(v) : null);

/** The 1Click asset for `token` on `chain` (native: the `nep141:` entry first), or null. */
export function oneClickAsset(tokens: readonly OneClickToken[], chain: SwapChain, token: string, decimals: number): OneClickToken | null {
  const all = tokens.filter((t) => oneClickAssetIs(t, chain, token)).sort((a, b) => Number(b.assetId.startsWith('nep141:')) - Number(a.assetId.startsWith('nep141:')));
  const t = all[0];
  return t && t.decimals === decimals ? t : null;
}

export interface OneClickQuoteExpect {
  originAsset: string;
  destinationAsset: string;
  amount: bigint;
  recipient: string;
  refundTo: string;
  fromChain: SwapChain;
  toChain: SwapChain;
  slippageBps: number;
  fee: NearFee | null;
  dry: boolean;
}

/** Checks a 1Click quote answer against what Kyro asked. Throws `SwapCheckError`. */
export function checkOneClickQuote(r: OneClickQuoteAnswer, e: OneClickQuoteExpect): { amountOut: bigint; minAmountOut: bigint; depositAddress: string | null; kyroFeeBps: number; oneClickFeeBps: number; timeEstimateSecs: number | null } {
  const req = r.quoteRequest;
  const q = r.quote;
  if (!req || !q) return fail(r.message ? l10n(`pas de devis (${r.message})`, `no quote (${r.message})`) : l10n('réponse illisible', 'unreadable response'));
  if (req.originAsset !== e.originAsset || req.destinationAsset !== e.destinationAsset) fail(l10n('tokens du devis différents de ceux demandés', 'quote tokens differ from the requested ones'));
  if (req.swapType !== 'EXACT_INPUT') fail(l10n('type d’échange inattendu', 'unexpected swap type'));
  if ((req.depositMode ?? 'SIMPLE') !== 'SIMPLE' || q.depositMemo) fail(l10n('dépôt avec mémo demandé (Kyro n’envoie qu’un transfert simple)', 'deposit with memo requested (Kyro only sends a plain transfer)'));
  if (req.recipientType !== 'DESTINATION_CHAIN' || !sameAddr(e.toChain, req.recipient, e.recipient)) fail(l10n(`destinataire ${req.recipient ?? '?'} au lieu de ton adresse`, `recipient ${req.recipient ?? '?'} instead of your address`));
  if (req.refundType !== 'ORIGIN_CHAIN' || !sameAddr(e.fromChain, req.refundTo, e.refundTo)) fail(l10n('remboursement prévu vers une autre adresse que la tienne', 'refund planned to an address other than yours'));
  if (big(req.amount) !== e.amount || big(q.amountIn) !== e.amount) fail(l10n('montant différent de ta saisie', 'amount differs from what you entered'));
  const fees = checkAppFees(req.appFees, e.fee ? { recipient: e.fee.recipient, bps: e.fee.bps, oneClickMaxBps: e.fee.bps } : { recipient: '', bps: 0, oneClickMaxBps: 25 });
  const out = big(q.amountOut);
  const min = big(q.minAmountOut);
  if (out === null || min === null || out <= 0n || min <= 0n || min > out) return fail(l10n('montant reçu ou minimum garanti absent', 'received amount or guaranteed minimum missing'));
  if (min < applySlippage(out, Math.min(10_000, e.slippageBps + 1))) fail(l10n('minimum garanti plus bas que le slippage choisi', 'guaranteed minimum lower than the chosen slippage'));
  const depositAddress = q.depositAddress ?? null;
  if (!e.dry && !depositAddress) fail(l10n('adresse de dépôt absente', 'deposit address missing'));
  if (!e.dry && sameAddr(e.fromChain, depositAddress ?? '', e.refundTo)) fail(l10n('adresse de dépôt = ta propre adresse', 'deposit address = your own address'));
  return { amountOut: out, minAmountOut: min, depositAddress, kyroFeeBps: fees.kyro, oneClickFeeBps: fees.other, timeEstimateSecs: typeof q.timeEstimate === 'number' ? q.timeEstimate : null };
}

export class NearIntentsProvider implements SwapProvider {
  readonly id = 'near' as const;
  readonly name = 'NEAR Intents';
  readonly host = NEAR_INTENTS_HOST;
  private readonly fetcher: NetFetch;
  private readonly fee: ProviderFee & { requestBps?: number };
  readonly client: NearIntentsClient;
  /** `appFees[0].fee` sent per Kyro rate: twice our rate, re-derived once if 1Click's echoed split differs. */
  private readonly requestBps = new Map<number, number>();

  constructor(opts: { fetch?: NetFetch; fee?: ProviderFee & { requestBps?: number } } = {}) {
    this.fetcher = opts.fetch ?? netFetch;
    this.fee = opts.fee ?? { kind: 'none' };
    this.client = new NearIntentsClient(this.fetcher);
  }

  available(): boolean {
    return this.unavailableReason() === null;
  }

  unavailableReason(): string | null {
    return this.fee.kind === 'unavailable' ? this.fee.reason : null;
  }

  /** Only the routes LI.FI does not serve (and never a same-chain EVM / Solana swap). */
  supports(p: QuoteParams): boolean {
    const to = p.toChain ?? p.chain;
    if (ONE_CLICK_CHAINS[String(p.chain)] === undefined || ONE_CLICK_CHAINS[String(to)] === undefined) return false;
    if (ONE_CLICK_ARRIVAL_ONLY.has(p.chain)) return false;
    if (lifiSource(p.chain) && (to === p.chain || lifiDestination(to))) return false;
    return true;
  }

  /** The fee of THIS quote: the curve's rate for its USD value (≤ 250 bps), asked for then demanded back. */
  private nearFee(p: QuoteParams): NearFee | null {
    if (this.fee.kind === 'unavailable') throw new Error(this.fee.reason);
    const f = feeForQuote(this.fee, p);
    if (f.kind !== 'fee') return null;
    const fixed = this.fee.kind === 'fee' ? this.fee.requestBps : undefined;
    return { bps: f.bps, recipient: f.recipient.toLowerCase(), requestBps: this.requestBps.get(f.bps) ?? fixed ?? f.bps * ONE_CLICK_FEE_REQUEST_FACTOR };
  }

  private async ask(p: QuoteParams, dry: boolean, retried = false): Promise<{ answer: OneClickQuoteAnswer; expect: OneClickQuoteExpect }> {
    const toChain = p.toChain ?? p.chain;
    const recipient = p.recipient ?? (toChain === p.chain ? p.taker : '');
    if (!recipient) throw new Error(l10n('NEAR Intents : pas de compte à toi sur la chaîne de destination', 'NEAR Intents: no account of yours on the destination chain'));
    const fee = this.nearFee(p);
    let tokens: OneClickToken[];
    try {
      tokens = await this.client.tokenList();
    } catch (e) {
      throw providerError(this.name, e);
    }
    const origin = oneClickAsset(tokens, p.chain, p.sell.address, p.sell.decimals);
    const dest = oneClickAsset(tokens, toChain, p.buy.address, p.buy.decimals);
    if (!origin || !dest) throw new Error(l10n(`NEAR Intents : ${!origin ? p.sell.symbol : p.buy.symbol} non pris en charge sur cette chaîne`, `NEAR Intents: ${!origin ? p.sell.symbol : p.buy.symbol} not supported on this chain`));
    const body = {
      dry,
      swapType: 'EXACT_INPUT',
      depositMode: 'SIMPLE',
      slippageTolerance: p.slippageBps,
      originAsset: origin.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: dest.assetId,
      amount: p.sellAmount.toString(),
      refundTo: p.taker,
      refundType: 'ORIGIN_CHAIN',
      recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      ...(fee ? { appFees: [{ recipient: fee.recipient, fee: fee.requestBps }] } : {}),
    };
    let answer: OneClickQuoteAnswer;
    try {
      answer = await fetchJson<OneClickQuoteAnswer>(this.fetcher, `https://${NEAR_INTENTS_HOST}/v0/quote`, { method: 'POST', body });
    } catch (e) {
      throw providerError(this.name, e);
    }
    // 1Click split the fee differently: retry once with the request that pays exactly `bps`.
    const ours = fee ? answer.quoteRequest?.appFees?.find((f) => (f.recipient ?? '').toLowerCase() === fee.recipient)?.fee : undefined;
    if (fee && !retried && typeof ours === 'number' && Number.isInteger(ours) && ours > 0 && ours !== fee.bps) {
      const next = Math.round((fee.requestBps * fee.bps) / ours);
      if (next >= fee.bps && next <= ONE_CLICK_MAX_TOTAL_BPS && next !== fee.requestBps) {
        this.requestBps.set(fee.bps, next);
        return this.ask(p, dry, true);
      }
    }
    return { answer, expect: { originAsset: origin.assetId, destinationAsset: dest.assetId, amount: p.sellAmount, recipient, refundTo: p.taker, fromChain: p.chain, toChain, slippageBps: p.slippageBps, fee, dry } };
  }

  async quote(p: QuoteParams): Promise<Quote> {
    if (!this.supports(p)) throw new Error(l10n('NEAR Intents : route non prise en charge', 'NEAR Intents: route not supported'));
    const toChain = p.toChain ?? p.chain;
    const { answer, expect } = await this.ask(p, true);
    const c = checkOneClickQuote(answer, expect);
    const fee = expect.fee;
    const sellFiat = p.sell.priceFiat !== undefined ? (Number(p.sellAmount) / 10 ** p.sell.decimals) * p.sell.priceFiat : null;
    const prepare = async (): Promise<DepositPlan> => {
      const real = await this.ask(p, false);
      const r = checkOneClickQuote(real.answer, real.expect);
      return this.confirm(p, toChain, expect.recipient, r.depositAddress as string, r.minAmountOut, fee);
    };
    const out: Quote = {
      provider: this.id,
      providerName: this.name,
      buyAmount: c.amountOut,
      minBuyAmount: c.minAmountOut,
      gasFeeFiat: null,
      providerFeeFiat: sellFiat !== null ? (sellFiat * c.oneClickFeeBps) / 10_000 : null,
      providerFeeIncluded: true,
      kyroFeeBps: c.kyroFeeBps,
      priceImpact: null,
      allowanceTarget: null,
      tx: { kind: 'deposit', chain: p.chain, prepare, reconfirm: (plan) => this.confirm(p, toChain, expect.recipient, plan.depositAddress, plan.minAmountOut, fee) },
      cross: { fromChain: p.chain, toChain, recipient: expect.recipient, bridge: '1click', bridgeName: this.name },
      route: `via ${this.name}`,
    };
    if (c.timeEstimateSecs !== null) out.etaSecs = c.timeEstimateSecs;
    return out;
  }

  /** 1Click itself (`/v0/status`) must confirm the deposit address: recipient, refund, amount, token, minimum, fee. */
  private async confirm(p: QuoteParams, toChain: SwapChain, recipient: string, depositAddress: string, minAmountOut: bigint, fee: NearFee | null): Promise<DepositPlan> {
    const n = await this.client.confirm({
      depositAddress,
      amountIn: p.sellAmount,
      fromChain: p.chain,
      toChain,
      buyToken: p.buy.address,
      recipient,
      refundTo: p.taker,
      minAmountOut,
      appFee: fee ? { recipient: fee.recipient, bps: fee.bps, oneClickMaxBps: fee.bps } : { recipient: '', bps: 0, oneClickMaxBps: 25 },
      minTimeLeftMs: NEAR_MIN_TIME_LEFT_MS,
    });
    return { depositAddress, amountIn: p.sellAmount, amountOut: n.amountOut, minAmountOut: n.minAmountOut, deadline: n.deadline, kyroFeeBps: n.kyroFeeBps, oneClickFeeBps: n.otherFeeBps, timeEstimateSecs: n.timeEstimateSecs };
  }
}

/** Direct 1Click swap status (`/v0/status`), for the history: SUCCESS, REFUNDED, FAILED, or in progress. */
export async function nearDepositStatus(fetcher: NetFetch, depositAddress: string): Promise<{ status: string; destinationTxHash?: string }> {
  const r = await fetchJson<{ status?: string; swapDetails?: { destinationChainTxHashes?: Array<{ hash?: string }> } }>(fetcher, `https://${NEAR_INTENTS_HOST}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  const hash = r.swapDetails?.destinationChainTxHashes?.[0]?.hash;
  return { status: r.status ?? 'NOT_FOUND', ...(hash ? { destinationTxHash: hash } : {}) };
}
