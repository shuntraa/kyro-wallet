// SPDX-License-Identifier: GPL-3.0-or-later
//
// LI.FI (li.quest): same-chain and cross-chain EVM routes. Works without a key
// (reduced quota).

import { fetchJson, netFetch, type NetFetch } from '@kyro/shared';
import type { Quote, QuoteParams, SwapProvider } from '../types';
import { ZERO_ADDRESS, isNative, providerError, qs, toBig, type ProviderOptions } from './common';

interface LifiQuote {
  toolDetails?: { name: string };
  estimate: {
    toAmount: string;
    toAmountMin: string;
    approvalAddress?: string;
    executionDuration?: number;
    gasCosts?: Array<{ amountUSD?: string }>;
    feeCosts?: Array<{ amountUSD?: string; included?: boolean }>;
  };
  transactionRequest: { to: string; data: `0x${string}`; value?: string; gasLimit?: string; gasPrice?: string };
}

export class LifiProvider implements SwapProvider {
  readonly id = 'lifi' as const;
  readonly name = 'LI.FI';
  readonly host = 'li.quest';
  private readonly fetcher: NetFetch;

  constructor(opts: ProviderOptions = {}) {
    this.fetcher = opts.fetch ?? netFetch;
  }

  available(): boolean {
    return true;
  }

  supports(p: QuoteParams): boolean {
    return typeof p.chain === 'number' && (p.toChain === undefined || typeof p.toChain === 'number');
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
    })}`;
    let r: LifiQuote;
    try {
      r = await fetchJson<LifiQuote>(this.fetcher, url);
    } catch (e) {
      throw providerError(this.name, e);
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
      priceImpact: null,
      allowanceTarget: isNative(p.sell.address) ? null : r.estimate.approvalAddress ?? r.transactionRequest.to,
      tx: { kind: 'evm', chainId: p.chain, to: r.transactionRequest.to, data: r.transactionRequest.data, value: toBig(r.transactionRequest.value), ...(gas > 0n ? { gas } : {}) },
    };
    if (r.toolDetails?.name) out.route = `via ${r.toolDetails.name}`;
    if (r.estimate.executionDuration !== undefined) out.etaSecs = r.estimate.executionDuration;
    return out;
  }
}
