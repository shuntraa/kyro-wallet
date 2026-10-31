// SPDX-License-Identifier: GPL-3.0-or-later
//
// 0x Swap API v2, allowance-holder flow (plain ERC-20 approve, no Permit2
// signature). Header `0x-api-key` is injected by the shell; `0x-version` is sent.
// Kyro fee: swapFeeRecipient + swapFeeBps + swapFeeToken=sellToken (docs.0x.org, « Monetize your app
// using Swap »). Taken from the sell token, so `buyAmount` is what the remaining amount buys; the
// response must echo it in `fees.integratorFee`, otherwise the quote is refused.

import { fetchJson, netFetch, type NetFetch } from '@kyro/shared';
import { gasFiat } from '../compare';
import type { Quote, QuoteParams, SwapProvider } from '../types';
import type { ProviderFee } from '../fees';
import { isNative, providerError, qs, toBig, unavailableReason, type ProviderOptions } from './common';

interface ZeroExQuote {
  liquidityAvailable?: boolean;
  buyAmount: string;
  minBuyAmount: string;
  allowanceTarget?: string | null;
  issues?: { allowance?: { actual: string; spender: string } | null } | null;
  fees?: { zeroExFee?: { amount: string; token: string } | null; integratorFee?: { amount: string; token: string } | null } | null;
  totalNetworkFee?: string | null;
  route?: { fills?: Array<{ source: string }> } | null;
  transaction: { to: string; data: `0x${string}`; gas?: string | null; gasPrice?: string | null; value?: string | null };
}

export class ZeroExProvider implements SwapProvider {
  readonly id = 'zerox' as const;
  readonly name = '0x';
  readonly host = 'api.0x.org';
  private readonly fetcher: NetFetch;
  private readonly hasKey: () => boolean;
  private readonly fee: ProviderFee;

  constructor(opts: ProviderOptions = {}) {
    this.fetcher = opts.fetch ?? netFetch;
    this.hasKey = opts.hasKey ?? (() => false);
    this.fee = opts.fee ?? { kind: 'none' };
  }

  available(): boolean {
    return this.unavailableReason() === null;
  }

  unavailableReason(): string | null {
    return unavailableReason(this.fee, this.hasKey());
  }

  supports(p: QuoteParams): boolean {
    return typeof p.chain === 'number' && (p.toChain === undefined || p.toChain === p.chain);
  }

  async quote(p: QuoteParams): Promise<Quote> {
    if (typeof p.chain !== 'number') throw new Error('0x : réseau non pris en charge');
    const url = `https://api.0x.org/swap/allowance-holder/quote?${qs({
      chainId: p.chain,
      sellToken: p.sell.address,
      buyToken: p.buy.address,
      sellAmount: p.sellAmount.toString(),
      taker: p.taker,
      slippageBps: p.slippageBps,
      ...(this.fee.kind === 'fee' ? { swapFeeRecipient: this.fee.recipient, swapFeeBps: this.fee.bps, swapFeeToken: p.sell.address } : {}),
    })}`;
    let r: ZeroExQuote;
    try {
      r = await fetchJson<ZeroExQuote>(this.fetcher, url, { headers: { '0x-version': 'v2' } });
    } catch (e) {
      throw providerError(this.name, e);
    }
    if (r.liquidityAvailable === false) throw new Error('0x : pas de liquidité pour cette paire');
    if (this.fee.kind === 'fee' && !(r.fees?.integratorFee && toBig(r.fees.integratorFee.amount) > 0n)) throw new Error('0x : frais Kyro non appliqués par le devis');
    const gas = toBig(r.transaction.gas);
    const gasPrice = toBig(r.transaction.gasPrice);
    const networkWei = r.totalNetworkFee ? toBig(r.totalNetworkFee) : gas * gasPrice;
    const fee = r.fees?.zeroExFee;
    let providerFeeFiat: number | null = 0;
    if (fee) {
      const ft = fee.token.toLowerCase();
      const t = ft === p.buy.address.toLowerCase() ? p.buy : ft === p.sell.address.toLowerCase() ? p.sell : null;
      providerFeeFiat = t?.priceFiat !== undefined ? (Number(fee.amount) / 10 ** t.decimals) * t.priceFiat : null;
    }
    const sources = [...new Set((r.route?.fills ?? []).map((f) => f.source.replace(/_/g, ' ')))];
    const out: Quote = {
      provider: this.id,
      providerName: this.name,
      buyAmount: toBig(r.buyAmount),
      minBuyAmount: toBig(r.minBuyAmount),
      gasFeeFiat: gasFiat(networkWei, 1n, p.nativePriceFiat),
      providerFeeFiat,
      providerFeeIncluded: true,
      kyroFeeBps: this.fee.kind === 'fee' ? this.fee.bps : 0,
      priceImpact: null,
      allowanceTarget: isNative(p.sell.address) ? null : r.issues?.allowance?.spender ?? r.allowanceTarget ?? r.transaction.to,
      tx: { kind: 'evm', chainId: p.chain, to: r.transaction.to, data: r.transaction.data, value: toBig(r.transaction.value), ...(gas > 0n ? { gas } : {}) },
      etaSecs: 15,
    };
    if (sources.length) out.route = sources.join(' + ');
    return out;
  }
}
