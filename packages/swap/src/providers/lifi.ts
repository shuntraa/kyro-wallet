// SPDX-License-Identifier: GPL-3.0-or-later
//
// LI.FI (li.quest): same-chain EVM swaps, and cross-chain swaps between EVM chains, Solana and
// (as a destination) Bitcoin. Works without a key (reduced quota).
//
// Kyro fee: `distributionFees[0][receiver]` + `[percentage]` (FRACTION, 0.007 = 0,7 %) (docs.li.fi,
// « Monetizing the integration »): paid straight to the receiver, no portal registration needed,
// taken from the SENT token on the SOURCE chain and `included` in `toAmount`. So the receiver is
// our address on the source chain: `recipients.evm` for an EVM source, `recipients.solana` for a
// Solana source (li.quest refuses an EVM receiver there). The quote must list it back (feeCosts
// « Distributions » with our receiver and percentage), otherwise it is refused.
//
// Same chain: verify.ts decodes GenericSwapFacetV3 (`_receiver` = taker, `_minAmountOut`, steps,
// FeeForwarder).
// Cross-chain: only the NEAR Intents bridge (`allowBridges=near`), the one whose transactions Kyro
// decodes end to end. The destination address is OUR account on the destination chain (`toAddress`,
// never typed). EVM source: verify.ts decodes `NEARIntentsFacet` (receiver, refund, minimum,
// destination token, fee step); Solana source: lifi-cross.ts checks the transaction Rust decoded.
// In both cases NEAR Intents itself must confirm the deposit address (near-intents.ts).

import { fetchJson, netFetch, type NetFetch, type SolTxSummary, l10n } from '@kyro/shared';
import type { CrossChainInfo, Quote, QuoteParams, SolanaRouteCheck, SwapChain, SwapProvider } from '../types';
import type { ProviderFee } from '../fees';
import { ZERO_ADDRESS, WSOL_MINT, isNative, providerError, qs, toBig, unavailableReason, type ProviderOptions } from './common';
import { lifiChainId, verifyEvmSwap, SwapCheckError } from '../verify';
import { applySlippage } from '../compare';
import { NearIntentsClient, ONE_CLICK_CHAINS } from '../near-intents';
import { solWireCostLamports, verifyLifiSolanaSource } from '../lifi-cross';

interface LifiFeeCost {
  name?: string;
  amount?: string;
  amountUSD?: string;
  included?: boolean;
  percentage?: string;
  feeSplit?: { recipients?: Array<{ walletAddress?: string }> };
}

export interface LifiQuote {
  tool?: string;
  toolDetails?: { key?: string; name: string };
  estimate: {
    toAmount: string;
    toAmountMin: string;
    approvalAddress?: string;
    executionDuration?: number;
    gasCosts?: Array<{ amountUSD?: string }>;
    feeCosts?: LifiFeeCost[];
  };
  /** EVM: a call; Solana: `{ data: <base64 wire> }`. */
  transactionRequest: { to?: string; data: string; value?: string; gasLimit?: string; gasPrice?: string };
}

/** Bridges Kyro accepts on cross-chain routes (the ones it decodes). */
export const LIFI_CROSS_BRIDGES = ['near'] as const;
const BRIDGE_NAMES: Record<string, string> = { near: 'NEAR Intents' };
const SOL_NATIVE = '11111111111111111111111111111111';

/** Token id as LI.FI names it on `chain`. */
function lifiToken(chain: SwapChain, address: string): string {
  if (chain === 'solana') return address === WSOL_MINT ? SOL_NATIVE : address;
  if (chain === 'bitcoin') return 'bitcoin';
  return isNative(address) ? ZERO_ADDRESS : address;
}

/** Is our Kyro fee echoed at the right rate to the right receiver? (EVM receivers compared case-insensitively.) */
export function lifiFeeEchoed(fees: readonly LifiFeeCost[] | undefined, recipient: string, bps: number, evm: boolean): boolean {
  const want = evm ? recipient.toLowerCase() : recipient;
  return (fees ?? []).some((f) => Math.round(Number(f.percentage ?? 0) * 10_000) === bps && (f.feeSplit?.recipients ?? []).some((x) => (evm ? x.walletAddress?.toLowerCase() : x.walletAddress) === want));
}

/**
 * Kyro chains LI.FI routes (`GET https://li.quest/v1/chains?chainTypes=EVM`, 2026-10-31: every
 * Kyro EVM chain except Conflux eSpace) AND where Kyro knows the Diamond (verify.ts; Flare, Kaia
 * and HyperEVM with their own Diamond, `LIFI_OTHER_DEPLOYMENTS`). Not Sepolia (no checked contract).
 */
export const LIFI_CHAINS: ReadonlySet<number> = new Set([1, 42_161, 10, 8_453, 137, 56, 43_114, 25, 5_000, 146, 100, 1_329, 14, 999, 8_217]);

export class LifiProvider implements SwapProvider {
  readonly id = 'lifi' as const;
  readonly name = 'LI.FI';
  readonly host = 'li.quest';
  private readonly fetcher: NetFetch;
  private readonly fee: ProviderFee;
  private readonly solFee: ProviderFee;
  readonly near: NearIntentsClient;

  constructor(opts: ProviderOptions & { solFee?: ProviderFee } = {}) {
    this.fetcher = opts.fetch ?? netFetch;
    this.fee = opts.fee ?? { kind: 'none' };
    this.solFee = opts.solFee ?? this.fee;
    this.near = new NearIntentsClient(this.fetcher);
  }

  available(): boolean {
    return this.unavailableReason() === null;
  }

  unavailableReason(): string | null {
    return unavailableReason(this.fee, true);
  }

  supports(p: QuoteParams): boolean {
    const to = p.toChain ?? p.chain;
    if (to === p.chain) return typeof p.chain === 'number' && LIFI_CHAINS.has(p.chain);
    // Cross-chain: from EVM or Solana, to EVM, Solana or Bitcoin, on chains NEAR Intents serves.
    // (Litecoin, Dogecoin, TRON, XRP, Cardano: NEAR Intents 1Click directly, providers/near.ts.)
    const lifiSide = (c: typeof to) => (typeof c === 'number' && LIFI_CHAINS.has(c)) || c === 'solana';
    return lifiSide(p.chain) && (lifiSide(to) || to === 'bitcoin') && ONE_CLICK_CHAINS[String(p.chain)] !== undefined && ONE_CLICK_CHAINS[String(to)] !== undefined;
  }

  async quote(p: QuoteParams): Promise<Quote> {
    const toChain = p.toChain ?? p.chain;
    if (toChain === p.chain) {
      if (typeof p.chain !== 'number') throw new Error(l10n('LI.FI : réseau non pris en charge', 'LI.FI: network not supported'));
      return this.sameChain(p, p.chain);
    }
    if (!this.supports(p)) throw new Error(l10n('LI.FI : routes entre ces deux chaînes non prises en charge par Kyro', 'LI.FI: routes between these two chains are not supported by Kyro'));
    return typeof p.chain === 'number' ? this.evmCross(p, p.chain, toChain) : this.solanaCross(p, toChain);
  }

  private async get(p: QuoteParams, extra: Record<string, string | number | undefined>, fee: ProviderFee): Promise<LifiQuote> {
    const toChain = p.toChain ?? p.chain;
    const url = `https://li.quest/v1/quote?${qs({
      fromChain: lifiChainId(p.chain),
      toChain: lifiChainId(toChain),
      fromToken: lifiToken(p.chain, p.sell.address),
      toToken: lifiToken(toChain, p.buy.address),
      fromAmount: p.sellAmount.toString(),
      fromAddress: p.taker,
      slippage: p.slippageBps / 10_000,
      ...extra,
      ...(fee.kind === 'fee' ? { 'distributionFees[0][receiver]': fee.recipient, 'distributionFees[0][percentage]': fee.bps / 10_000 } : {}),
    })}`;
    let r: LifiQuote;
    try {
      r = await fetchJson<LifiQuote>(this.fetcher, url);
    } catch (e) {
      throw providerError(this.name, e);
    }
    if (fee.kind === 'fee' && !lifiFeeEchoed(r.estimate.feeCosts, fee.recipient, fee.bps, typeof p.chain === 'number')) throw new Error(l10n('LI.FI : frais Kyro non appliqués par le devis', 'LI.FI: Kyro fees not applied by the quote'));
    return r;
  }

  private base(p: QuoteParams, r: LifiQuote, fee: ProviderFee): Omit<Quote, 'tx' | 'minBuyAmount' | 'allowanceTarget' | 'gasFeeFiat'> {
    const fx = p.usdToFiat ?? 1;
    const fees = r.estimate.feeCosts ?? [];
    const sum = (xs: Array<{ amountUSD?: string }> | undefined) => (xs ?? []).reduce((s, x) => s + Number(x.amountUSD ?? 0), 0);
    const out: Omit<Quote, 'tx' | 'minBuyAmount' | 'allowanceTarget' | 'gasFeeFiat'> = {
      provider: this.id,
      providerName: this.name,
      buyAmount: toBig(r.estimate.toAmount),
      // LI.FI's own fees only: « Distributions » is the Kyro fee (counted with `kyroFeeBps`).
      providerFeeFiat: sum(fees.filter((f) => f.name !== 'Distributions')) * fx,
      providerFeeIncluded: fees.every((f) => f.included !== false),
      kyroFeeBps: fee.kind === 'fee' ? fee.bps : 0,
      priceImpact: null,
    };
    if (r.estimate.executionDuration !== undefined) out.etaSecs = r.estimate.executionDuration;
    return out;
  }

  private async sameChain(p: QuoteParams, chain: number): Promise<Quote> {
    const r = await this.get(p, {}, this.fee);
    const fx = p.usdToFiat ?? 1;
    const tx = r.transactionRequest;
    const gas = toBig(tx.gasLimit);
    const allowanceTarget = isNative(p.sell.address) ? null : r.estimate.approvalAddress ?? tx.to ?? null;
    const value = toBig(tx.value);
    const check = verifyEvmSwap({
      provider: 'lifi',
      chainId: chain,
      sell: p.sell,
      buy: p.buy,
      sellAmount: p.sellAmount,
      taker: p.taker,
      slippageBps: p.slippageBps,
      buyAmount: toBig(r.estimate.toAmount),
      tx: { to: tx.to ?? '', data: tx.data as `0x${string}`, value },
      allowanceTarget,
      fee: this.fee,
    });
    const out: Quote = {
      ...this.base(p, r, this.fee),
      // What the Diamond enforces (decoded `_minAmountOut`), never only what the answer claims.
      minBuyAmount: check.minBuyAmount < toBig(r.estimate.toAmountMin) ? check.minBuyAmount : toBig(r.estimate.toAmountMin),
      gasFeeFiat: (r.estimate.gasCosts ?? []).reduce((s, x) => s + Number(x.amountUSD ?? 0), 0) * fx,
      allowanceTarget: allowanceTarget === null ? null : check.contract,
      tx: { kind: 'evm', chainId: chain, to: check.contract, data: tx.data as `0x${string}`, value, ...(gas > 0n ? { gas } : {}) },
      evmCheck: check,
    };
    if (r.toolDetails?.name) out.route = `via ${r.toolDetails.name}`;
    return out;
  }

  private crossInfo(p: QuoteParams, toChain: SwapChain, r: LifiQuote): CrossChainInfo {
    const bridge = r.tool ?? r.toolDetails?.key ?? '';
    if (!(LIFI_CROSS_BRIDGES as readonly string[]).includes(bridge)) throw new SwapCheckError(l10n(`LI.FI : pont « ${bridge || '?'} » non vérifiable par Kyro — devis refusé.`, `LI.FI: bridge “${bridge || '?'}” cannot be checked by Kyro — quote refused.`));
    return { fromChain: p.chain, toChain, recipient: p.recipient ?? p.taker, bridge, bridgeName: BRIDGE_NAMES[bridge] ?? bridge };
  }

  private async evmCross(p: QuoteParams, chain: number, toChain: SwapChain): Promise<Quote> {
    const recipient = p.recipient ?? (typeof toChain === 'number' ? p.taker : '');
    if (!recipient) throw new Error(l10n('LI.FI : pas de compte à toi sur la chaîne de destination', 'LI.FI: no account of yours on the destination chain'));
    // LI.FI applies the slippage to EACH leg (source DEX swap, then the bridge): live quotes give a
    // minimum ≈ 1 − 2 × slippage. Half per leg keeps the whole route within the user's choice,
    // which is what verify.ts then enforces on the bridge minimum.
    const legSlippage = Math.max(1, Math.floor(p.slippageBps / 2)) / 10_000;
    const r = await this.get(p, { toAddress: recipient, allowBridges: LIFI_CROSS_BRIDGES.join(','), slippage: legSlippage }, this.fee);
    const cross = this.crossInfo({ ...p, recipient }, toChain, r);
    const fx = p.usdToFiat ?? 1;
    const tx = r.transactionRequest;
    const gas = toBig(tx.gasLimit);
    const allowanceTarget = isNative(p.sell.address) ? null : r.estimate.approvalAddress ?? tx.to ?? null;
    const value = toBig(tx.value);
    const buyAmount = toBig(r.estimate.toAmount);
    const check = verifyEvmSwap({
      provider: 'lifi',
      chainId: chain,
      sell: p.sell,
      buy: p.buy,
      sellAmount: p.sellAmount,
      taker: p.taker,
      slippageBps: p.slippageBps,
      buyAmount,
      tx: { to: tx.to ?? '', data: tx.data as `0x${string}`, value },
      allowanceTarget,
      fee: this.fee,
      cross: { toChain, recipient },
    });
    const bridge = check.bridge;
    if (!bridge) throw new SwapCheckError(l10n('LI.FI : dépôt du pont absent — devis refusé.', 'LI.FI: bridge deposit missing — quote refused.'));
    // The bridge itself must confirm where this deposit goes (recipient, token, minimum, refund).
    const near = await this.near.confirm({ depositAddress: bridge.depositAddress, amountIn: bridge.amountIn, fromChain: chain, toChain, buyToken: p.buy.address, recipient, refundTo: p.taker, minAmountOut: check.minBuyAmount });
    const out: Quote = {
      ...this.base(p, r, this.fee),
      minBuyAmount: check.minBuyAmount < toBig(r.estimate.toAmountMin) ? check.minBuyAmount : toBig(r.estimate.toAmountMin),
      gasFeeFiat: (r.estimate.gasCosts ?? []).reduce((s, x) => s + Number(x.amountUSD ?? 0), 0) * fx,
      allowanceTarget: allowanceTarget === null ? null : check.contract,
      tx: { kind: 'evm', chainId: chain, to: check.contract, data: tx.data as `0x${string}`, value, ...(gas > 0n ? { gas } : {}) },
      evmCheck: check,
      cross: { ...cross, depositAddress: bridge.depositAddress },
      route: `via ${cross.bridgeName}`,
    };
    if (out.etaSecs === undefined && near.timeEstimateSecs !== null) out.etaSecs = near.timeEstimateSecs;
    return out;
  }

  private async solanaCross(p: QuoteParams, toChain: SwapChain): Promise<Quote> {
    if (this.solFee.kind === 'unavailable') throw new Error(this.solFee.reason);
    const fee = this.solFee;
    const recipient = p.recipient ?? '';
    if (!recipient) throw new Error(l10n('LI.FI : pas de compte à toi sur la chaîne de destination', 'LI.FI: no account of yours on the destination chain'));
    const params = { toAddress: recipient, allowBridges: LIFI_CROSS_BRIDGES.join(',') };
    const r = await this.get(p, params, fee);
    const cross = this.crossInfo({ ...p, recipient }, toChain, r);
    if (!r.transactionRequest.data || r.transactionRequest.to) throw new Error(l10n('LI.FI : transaction Solana attendue', 'LI.FI: Solana transaction expected'));
    const buyAmount = toBig(r.estimate.toAmount);
    const minBuyAmount = toBig(r.estimate.toAmountMin);
    if (minBuyAmount <= 0n || minBuyAmount < applySlippage(buyAmount, Math.min(10_000, p.slippageBps + 1))) throw new SwapCheckError(l10n('LI.FI : minimum garanti plus bas que le slippage choisi — devis refusé.', 'LI.FI: guaranteed minimum lower than the chosen slippage — quote refused.'));
    const lamports = solWireCostLamports(r.transactionRequest.data);
    const near = this.near;
    const get = () => this.get(p, params, fee);
    const kyro = fee.kind === 'fee' ? { bps: fee.bps, recipient: fee.recipient } : null;
    const verify = async (wire: string, summary: SolTxSummary): Promise<SolanaRouteCheck> => {
      const c = await verifyLifiSolanaSource({ wire, summary, taker: p.taker, sellMint: p.sell.address, sellAmount: p.sellAmount, fee: kyro });
      // Never less than the minimum the user reviewed (a lower fresh quote is refused, not taken).
      const n = await near.confirm({ depositAddress: c.depositAddress, amountIn: c.amountIn, fromChain: 'solana', toChain, buyToken: p.buy.address, recipient, refundTo: p.taker, minAmountOut: minBuyAmount });
      return { depositAddress: c.depositAddress, amountIn: c.amountIn, kyroFee: c.kyroFee, minAmountOut: n.minAmountOut };
    };
    return {
      ...this.base(p, r, fee),
      minBuyAmount,
      gasFeeFiat: lamports !== null && p.nativePriceFiat !== undefined ? (Number(lamports) / 1e9) * p.nativePriceFiat : null,
      allowanceTarget: null,
      // Every build is a fresh quote (a NEAR deposit address is single-use and the blockhash expires).
      tx: {
        kind: 'solana',
        build: async () => {
          const fresh = await get();
          if (fresh.transactionRequest.to || !fresh.transactionRequest.data) throw new Error(l10n('LI.FI : transaction Solana attendue', 'LI.FI: Solana transaction expected'));
          return fresh.transactionRequest.data;
        },
        verify,
      },
      cross,
      route: `via ${cross.bridgeName}`,
    };
  }
}

export interface LifiStatus {
  /** NOT_FOUND, INVALID, PENDING, DONE, FAILED (li.quest `/v1/status`). */
  status: string;
  substatus?: string;
  receivingTxHash?: string;
}

/** Cross-chain transfer status (docs.li.fi « Transaction status »): `GET li.quest/v1/status`. */
export async function lifiTransferStatus(fetcher: NetFetch, o: { txHash: string; fromChain: SwapChain; toChain: SwapChain; bridge?: string }): Promise<LifiStatus> {
  const url = `https://li.quest/v1/status?${qs({ txHash: o.txHash, fromChain: lifiChainId(o.fromChain), toChain: lifiChainId(o.toChain), bridge: o.bridge })}`;
  const r = await fetchJson<{ status?: string; substatus?: string; receiving?: { txHash?: string } }>(fetcher, url);
  const out: LifiStatus = { status: r.status ?? 'NOT_FOUND' };
  if (r.substatus) out.substatus = r.substatus;
  if (r.receiving?.txHash) out.receivingTxHash = r.receiving.txHash;
  return out;
}
