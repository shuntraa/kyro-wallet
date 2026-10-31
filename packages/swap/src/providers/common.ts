// SPDX-License-Identifier: GPL-3.0-or-later

import { HttpError, type NetFetch } from '@kyro/shared';
import type { ProviderFee } from '../fees';

export const NATIVE_EVM = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface ProviderOptions {
  fetch?: NetFetch;
  /**
   * Whether an API key is configured (Settings or env). The key itself is
   * injected by the Rust shell in net_fetch: it never transits through JS.
   */
  hasKey?: () => boolean;
  /** Kyro fee for this provider (see fees.ts). Default: no fee. */
  fee?: ProviderFee;
}

/** Shared `unavailableReason()`: Kyro fee first (it decides whether the provider may be used), then the API key. */
export function unavailableReason(fee: ProviderFee, hasKey: boolean): string | null {
  if (fee.kind === 'unavailable') return fee.reason;
  return hasKey ? null : 'Clé API non configurée';
}

export const isNative = (address: string) => address.toLowerCase() === NATIVE_EVM.toLowerCase() || address === ZERO_ADDRESS;

export function qs(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/** Turn provider error bodies into a short French message. */
export function providerError(name: string, e: unknown): Error {
  if (e instanceof HttpError) {
    let detail: string;
    try {
      const body = JSON.parse(e.body) as { message?: string; description?: string; error?: string; reason?: string; name?: string };
      detail = body.message ?? body.description ?? body.reason ?? body.error ?? body.name ?? '';
    } catch {
      detail = e.body.slice(0, 120);
    }
    if (e.status === 401 || e.status === 403) return new Error(`${name} : clé API refusée ou absente`);
    if (e.status === 429) return new Error(`${name} : trop de requêtes, réessaie dans un instant`);
    return new Error(`${name} : ${detail || `erreur HTTP ${e.status}`}`);
  }
  return e instanceof Error ? new Error(`${name} : ${e.message}`) : new Error(`${name} : erreur inconnue`);
}

export const toBig = (v: string | number | null | undefined): bigint => {
  if (v === null || v === undefined || v === '') return 0n;
  return BigInt(v);
};
