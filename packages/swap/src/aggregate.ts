// SPDX-License-Identifier: GPL-3.0-or-later

import type { NetFetch } from '@kyro/shared';
import { compareQuotes, type QuoteResult } from './compare';
import { JupiterProvider } from './providers/jupiter';
import { LifiProvider } from './providers/lifi';
import { OneInchProvider } from './providers/oneinch';
import { ZeroExProvider } from './providers/zerox';
import type { Quote, QuoteParams, SwapProvider } from './types';

export function createProviders(opts: { fetch?: NetFetch; hasZeroxKey: () => boolean; hasOneinchKey: () => boolean }): SwapProvider[] {
  const f = opts.fetch ? { fetch: opts.fetch } : {};
  return [
    new ZeroExProvider({ ...f, hasKey: opts.hasZeroxKey }),
    new OneInchProvider({ ...f, hasKey: opts.hasOneinchKey }),
    new LifiProvider(f),
    new JupiterProvider(f),
  ];
}

/** Ask every relevant provider in parallel. Returns quotes sorted best first + per-provider status. */
export async function fetchQuotes(providers: SwapProvider[], params: QuoteParams): Promise<{ quotes: Quote[]; results: QuoteResult[] }> {
  const relevant = providers.filter((p) => p.supports(params));
  const results = await Promise.all(
    relevant.map(async (p): Promise<QuoteResult> => {
      if (!p.available()) return { provider: p.id, providerName: p.name, error: 'Clé API non configurée' };
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
