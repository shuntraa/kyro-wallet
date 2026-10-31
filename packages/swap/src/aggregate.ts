// SPDX-License-Identifier: GPL-3.0-or-later

import type { NetFetch } from '@kyro/shared';
import { compareQuotes, type QuoteResult } from './compare';
import { JupiterProvider } from './providers/jupiter';
import { LifiProvider } from './providers/lifi';
import { ZeroExProvider } from './providers/zerox';
import { KYRO_SWAP_FEE, providerFee, type SwapFeeConfig } from './fees';
import type { Quote, QuoteParams, SwapProvider } from './types';

export function createProviders(opts: { fetch?: NetFetch; hasZeroxKey: () => boolean; fees?: SwapFeeConfig }): SwapProvider[] {
  const f = opts.fetch ? { fetch: opts.fetch } : {};
  const cfg = opts.fees ?? KYRO_SWAP_FEE;
  return [
    new ZeroExProvider({ ...f, hasKey: opts.hasZeroxKey, fee: providerFee('zerox', cfg) }),
    new LifiProvider({ ...f, fee: providerFee('lifi', cfg) }),
    new JupiterProvider({ ...f, fee: providerFee('jupiter', cfg), feeMints: cfg.solanaFeeMints }),
  ];
}

/** Ask every relevant provider in parallel. Returns quotes sorted best first + per-provider status. */
export async function fetchQuotes(providers: SwapProvider[], params: QuoteParams): Promise<{ quotes: Quote[]; results: QuoteResult[] }> {
  const relevant = providers.filter((p) => p.supports(params));
  const results = await Promise.all(
    relevant.map(async (p): Promise<QuoteResult> => {
      const reason = p.unavailableReason();
      if (reason) return { provider: p.id, providerName: p.name, error: reason };
      try {
        return { provider: p.id, providerName: p.name, quote: await p.quote(params) };
      } catch (e) {
        return { provider: p.id, providerName: p.name, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const quotes = compareQuotes(results.flatMap((r) => (r.quote ? [r.quote] : [])), params.buy);
  return { quotes, results };
}
