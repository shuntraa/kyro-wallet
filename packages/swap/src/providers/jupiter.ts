// SPDX-License-Identifier: GPL-3.0-or-later
//
// Jupiter (lite-api.jup.ag swap/v1): quote, then the swap transaction is built
// on demand (it embeds a recent blockhash). The Rust side signs the message bytes.

import { fetchJson, netFetch, type NetFetch } from '@kyro/shared';
import type { Quote, QuoteParams, SwapProvider } from '../types';
import { providerError, qs, toBig, type ProviderOptions } from './common';

interface JupQuote {
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct?: string;
  routePlan?: Array<{ swapInfo?: { label?: string } }>;
}

/** Network fee of a typical Jupiter swap (base fee + priority), lamports. */
const JUP_FEE_LAMPORTS = 25_000;

export class JupiterProvider implements SwapProvider {
  readonly id = 'jupiter' as const;
  readonly name = 'Jupiter';
  readonly host = 'lite-api.jup.ag';
  private readonly fetcher: NetFetch;

  constructor(opts: ProviderOptions = {}) {
    this.fetcher = opts.fetch ?? netFetch;
  }

  available(): boolean {
    return true;
  }

  supports(p: QuoteParams): boolean {
    return p.chain === 'solana' && (p.toChain === undefined || p.toChain === 'solana');
  }

  async quote(p: QuoteParams): Promise<Quote> {
    const url = `https://lite-api.jup.ag/swap/v1/quote?${qs({
      inputMint: p.sell.address,
      outputMint: p.buy.address,
      amount: p.sellAmount.toString(),
      slippageBps: p.slippageBps,
    })}`;
    let raw: JupQuote & Record<string, unknown>;
    try {
      raw = await fetchJson<JupQuote & Record<string, unknown>>(this.fetcher, url);
    } catch (e) {
      throw providerError(this.name, e);
    }
    const fetcher = this.fetcher;
    const labels = [...new Set((raw.routePlan ?? []).map((r) => r.swapInfo?.label).filter((x): x is string => !!x))];
    const impact = raw.priceImpactPct !== undefined ? Number(raw.priceImpactPct) : NaN;
    const out: Quote = {
      provider: this.id,
      providerName: this.name,
      buyAmount: toBig(raw.outAmount),
      minBuyAmount: toBig(raw.otherAmountThreshold),
      gasFeeFiat: p.nativePriceFiat !== undefined ? (JUP_FEE_LAMPORTS / 1e9) * p.nativePriceFiat : null,
      providerFeeFiat: 0,
      providerFeeIncluded: true,
      priceImpact: Number.isFinite(impact) ? impact : null,
      allowanceTarget: null,
      tx: {
        kind: 'solana',
        build: async () => {
          try {
            const r = await fetchJson<{ swapTransaction: string }>(fetcher, 'https://lite-api.jup.ag/swap/v1/swap', {
              method: 'POST',
              body: { quoteResponse: raw, userPublicKey: p.taker, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' },
            });
            return r.swapTransaction;
          } catch (e) {
            throw providerError('Jupiter', e);
          }
        },
      },
      etaSecs: 5,
    };
    if (labels.length) out.route = labels.join(' + ');
    return out;
  }
}
