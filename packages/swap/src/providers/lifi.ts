// SPDX-License-Identifier: GPL-3.0-or-later
//
// LI.FI (li.quest): same-chain and cross-chain EVM routes. Works without a key
// (reduced quota). Kyro fee: `distributionFees[0][receiver]` + `[percentage]` (FRACTION,
// 0.007 = 0,7 %) (docs.li.fi, « Monetizing the integration »): paid straight to the receiver, no
// portal registration needed. Taken from the sent token and `included` in `toAmount`. The quote must
// list it back (feeCosts « Distributions » with our receiver and percentage), otherwise it is refused.

import { fetchJson, netFetch, type NetFetch } from '@kyro/shared';
import type { Quote, QuoteParams, SwapProvider } from '../types';
import type { ProviderFee } from '../fees';
import { ZERO_ADDRESS, isNative, providerError, qs, toBig, unavailableReason, type ProviderOptions } from './common';

interface LifiQuote {
  toolDetails?: { name: string };
  estimate: {
    toAmount: string;
    toAmountMin: string;
    approvalAddress?: string;
    executionDuration?: number;
    gasCosts?: Array<{ amountUSD?: string }>;
    feeCosts?: Array<{ amountUSD?: string; included?: boolean; percentage?: string; feeSplit?: { recipients?: Array<{ walletAddress?: string }> } }>;
  };
  transactionRequest: { to: string; data: `0x${string}`; value?: string; gasLimit?: string; gasPrice?: string };
}

/**
 * Kyro chains LI.FI routes (`GET https://li.quest/v1/chains?chainTypes=EVM`, 2026-10-31):
 * every Kyro EVM chain except Conflux eSpace (1030). Sepolia: kept as before.
 */
export const LIFI_CHAINS: ReadonlySet<number> = new Set([1, 11_155_111, 42_161, 10, 8_453, 137, 56, 43_114, 25, 5_000, 146, 14, 8_217, 100, 999, 1_329]);

export class LifiProvider implements SwapProvider {
  readonly id = 'lifi' as const;
  readonly name = 'LI.FI';
  readonly host = 'li.quest';
  private readonly fetcher: NetFetch;
  private readonly fee: ProviderFee;

  constructor(opts: ProviderOptions = {}) {
    this.fetcher = opts.fetch ?? netFetch;
    this.fee = opts.fee ?? { kind: 'none' };
  }

  available(): boolean {
    return this.unavailableReason() === null;
  }

  unavailableReason(): string | null {
    return unavailableReason(this.fee, true);
  }

  supports(p: QuoteParams): boolean {
    return typeof p.chain === 'number' && LIFI_CHAINS.has(p.chain) && (p.toChain === undefined || (typeof p.toChain === 'number' && LIFI_CHAINS.has(p.toChain)));
  }

  async quote(p: QuoteParams): Promise<Quote> {
    if (typeof p.chain !== 'number') throw new Error('LI.FI : réseau non pris en charge');
    const toChain = typeof p.toChain === 'number' ? p.toChain : p.chain;
    const token = (a: string) => (isNative(a) ? ZERO_ADDRESS : a);
    const url = `https://li.quest/v1/quote?${qs({
      fromChain: p.chain,
      toChain,
      fromToken: token(p.sell.address),
      toToken: token(p.buy.address),
      fromAmount: p.sellAmount.toString(),
      fromAddress: p.taker,
      slippage: p.slippageBps / 10_000,
      ...(this.fee.kind === 'fee' ? { 'distributionFees[0][receiver]': this.fee.recipient, 'distributionFees[0][percentage]': this.fee.bps / 10_000 } : {}),
    })}`;
    let r: LifiQuote;
    try {
      r = await fetchJson<LifiQuote>(this.fetcher, url);
    } catch (e) {
      throw providerError(this.name, e);
    }
    if (this.fee.kind === 'fee') {
      const want = this.fee.recipient.toLowerCase();
      const bps = this.fee.bps;
      const echoed = (r.estimate.feeCosts ?? []).some((f) => Math.round(Number(f.percentage ?? 0) * 10_000) === bps && (f.feeSplit?.recipients ?? []).some((x) => x.walletAddress?.toLowerCase() === want));
      if (!echoed) throw new Error('LI.FI : frais Kyro non appliqués par le devis');
    }
    const fx = p.usdToFiat ?? 1;
    const sum = (xs: Array<{ amountUSD?: string }> | undefined) => (xs ?? []).reduce((s, x) => s + Number(x.amountUSD ?? 0), 0);
    const fees = r.estimate.feeCosts ?? [];
    const gas = toBig(r.transactionRequest.gasLimit);
    const out: Quote = {
      provider: this.id,
      providerName: this.name,
      buyAmount: toBig(r.estimate.toAmount),
      minBuyAmount: toBig(r.estimate.toAmountMin),
      gasFeeFiat: sum(r.estimate.gasCosts) * fx,
      providerFeeFiat: sum(fees) * fx,
      providerFeeIncluded: fees.every((f) => f.included !== false),
      kyroFeeBps: this.fee.kind === 'fee' ? this.fee.bps : 0,
      priceImpact: null,
      allowanceTarget: isNative(p.sell.address) ? null : r.estimate.approvalAddress ?? r.transactionRequest.to,
      tx: { kind: 'evm', chainId: p.chain, to: r.transactionRequest.to, data: r.transactionRequest.data, value: toBig(r.transactionRequest.value), ...(gas > 0n ? { gas } : {}) },
    };
    if (r.toolDetails?.name) out.route = `via ${r.toolDetails.name}`;
    if (r.estimate.executionDuration !== undefined) out.etaSecs = r.estimate.executionDuration;
    return out;
  }
}
