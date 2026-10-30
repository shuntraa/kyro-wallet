// SPDX-License-Identifier: GPL-3.0-or-later
//
// 1inch Swap API v6 (api.1inch.dev). `Authorization: Bearer …` is injected by the shell.

import { fetchJson, netFetch, type NetFetch } from '@kyro/shared';
import { applySlippage, gasFiat } from '../compare';
import type { Quote, QuoteParams, SwapProvider } from '../types';
import { isNative, providerError, qs, toBig, type ProviderOptions } from './common';

interface OneInchSwap {
  dstAmount: string;
  tx: { from: string; to: string; data: `0x${string}`; value: string; gas: number | string; gasPrice: string };
}

export class OneInchProvider implements SwapProvider {
  readonly id = 'oneinch' as const;
  readonly name = '1inch';
  readonly host = 'api.1inch.dev';
  private readonly fetcher: NetFetch;
  private readonly hasKey: () => boolean;

  constructor(opts: ProviderOptions = {}) {
    this.fetcher = opts.fetch ?? netFetch;
    this.hasKey = opts.hasKey ?? (() => false);
  }

  available(): boolean {
    return this.hasKey();
  }

  supports(p: QuoteParams): boolean {
    return typeof p.chain === 'number' && (p.toChain === undefined || p.toChain === p.chain);
  }

  async quote(p: QuoteParams): Promise<Quote> {
    if (typeof p.chain !== 'number') throw new Error('1inch : réseau non pris en charge');
    const url = `https://api.1inch.dev/swap/v6.0/${p.chain}/swap?${qs({
      src: p.sell.address,
      dst: p.buy.address,
      amount: p.sellAmount.toString(),
      from: p.taker,
      origin: p.taker,
      slippage: p.slippageBps / 100,
      disableEstimate: 'true',
      includeGas: 'true',
    })}`;
    let r: OneInchSwap;
    try {
      r = await fetchJson<OneInchSwap>(this.fetcher, url);
    } catch (e) {
      throw providerError(this.name, e);
    }
    const buyAmount = toBig(r.dstAmount);
    const gas = toBig(r.tx.gas);
    return {
      provider: this.id,
      providerName: this.name,
      buyAmount,
      minBuyAmount: applySlippage(buyAmount, p.slippageBps),
      gasFeeFiat: gasFiat(gas, toBig(r.tx.gasPrice), p.nativePriceFiat),
      providerFeeFiat: 0,
      providerFeeIncluded: true,
      priceImpact: null,
      allowanceTarget: isNative(p.sell.address) ? null : r.tx.to,
      tx: { kind: 'evm', chainId: p.chain, to: r.tx.to, data: r.tx.data, value: toBig(r.tx.value), ...(gas > 0n ? { gas } : {}) },
      route: '1inch Aggregation Router v6',
      etaSecs: 15,
    };
  }
}
