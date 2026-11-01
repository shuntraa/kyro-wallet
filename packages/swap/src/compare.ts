// SPDX-License-Identifier: GPL-3.0-or-later

import type { Quote, QuoteParams } from './types';

import { l10n } from '@kyro/shared';
/** Fiat value actually kept: received value − gas − provider fee (if not already deducted). */
export function netValueFiat(q: Quote, buy: QuoteParams['buy']): number | null {
  if (buy.priceFiat === undefined) return null;
  const received = (Number(q.buyAmount) / 10 ** buy.decimals) * buy.priceFiat;
  return received - (q.gasFeeFiat ?? 0) - (q.providerFeeIncluded ? 0 : q.providerFeeFiat ?? 0);
}

/**
 * Sort quotes by net received, best first.
 * With prices: net fiat value. Without: buyAmount (fees unknown → ignored).
 * Ties: higher minBuyAmount first.
 */
export function compareQuotes(quotes: Quote[], buy: QuoteParams['buy']): Quote[] {
  return [...quotes].sort((a, b) => {
    const na = netValueFiat(a, buy);
    const nb = netValueFiat(b, buy);
    if (na !== null && nb !== null && na !== nb) return nb - na;
    if (a.buyAmount !== b.buyAmount) return a.buyAmount > b.buyAmount ? -1 : 1;
    if (a.minBuyAmount !== b.minBuyAmount) return a.minBuyAmount > b.minBuyAmount ? -1 : 1;
    return 0;
  });
}

export interface QuoteResult {
  provider: string;
  providerName: string;
  quote?: Quote;
  error?: string;
}

/** Apply slippage to an expected amount (floor). */
export function applySlippage(amount: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new Error(l10n('Slippage invalide', 'Invalid slippage'));
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Fiat cost of `gas × gasPrice` wei. */
export function gasFiat(gas: bigint, gasPriceWei: bigint, nativePriceFiat: number | undefined): number | null {
  if (nativePriceFiat === undefined) return null;
  return (Number(gas * gasPriceWei) / 1e18) * nativePriceFiat;
}
