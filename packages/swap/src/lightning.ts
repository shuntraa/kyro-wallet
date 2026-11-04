// SPDX-License-Identifier: GPL-3.0-or-later
//
// Paying a Lightning invoice through a submarine swap (Boltz API v2 backends, no key). This file
// only talks to the providers and reads their answers: whether coins may go to a lockup address is
// decided by Rust (`ln_swap_accept`), which rebuilds that address itself. See docs/LIGHTNING.md.

import { fetchJson, HttpError, l10n, type NetFetch } from '@kyro/shared';

export type LnProviderId = 'coinos' | 'satsrouting';

export interface LnProvider {
  id: LnProviderId;
  name: string;
  /** SATS Routing's host is rewritten to its onion by Rust in Tor mode. */
  api: string;
}

export const LN_PROVIDERS: readonly LnProvider[] = [
  { id: 'coinos', name: 'Coinos', api: 'https://swap.coinos.io' },
  { id: 'satsrouting', name: 'SATS Routing', api: 'https://satsrouting.exchange' },
];

/** Same limit as Rust's `LN_MIN_INVOICE_MARGIN_SECS`, to refuse before contacting anyone. */
export const LN_MIN_INVOICE_MARGIN_SECS = 3_600;
/** A Kyro fee transfer below this would not relay. */
export const LN_MIN_KYRO_FEE_SAT = 546n;

export interface LnPair {
  provider: LnProvider;
  hash: string;
  minimal: number;
  maximal: number;
  percentage: number;
  minerFees: number;
}

interface PairAnswer {
  BTC?: { BTC?: { hash?: unknown; limits?: { minimal?: unknown; maximal?: unknown }; fees?: { percentage?: unknown; minerFees?: unknown } } };
}

const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Reads `GET /v2/swap/submarine`. Null when the BTC pair is missing or unreadable. */
export function parseLnPair(provider: LnProvider, a: PairAnswer): LnPair | null {
  const p = a.BTC?.BTC;
  const pct = p?.fees?.percentage;
  if (!p || typeof p.hash !== 'string' || !/^[0-9a-f]{64}$/.test(p.hash)) return null;
  if (!posInt(p.limits?.minimal) || !posInt(p.limits?.maximal) || !posInt(p.fees?.minerFees)) return null;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 5) return null;
  return { provider, hash: p.hash, minimal: p.limits.minimal, maximal: p.limits.maximal, percentage: pct, minerFees: p.fees.minerFees };
}

/** Every provider's pair; one that does not answer is left out. */
export async function lnPairs(fetcher: NetFetch): Promise<LnPair[]> {
  const got = await Promise.all(
    LN_PROVIDERS.map(async (p) => {
      try {
        return parseLnPair(p, await fetchJson<PairAnswer>(fetcher, `${p.api}/v2/swap/submarine`));
      } catch {
        return null;
      }
    }),
  );
  return got.filter((x): x is LnPair => x !== null);
}

/** What the provider adds to `amountSat`: percentage rounded up, then its miner fee. */
export function lnProviderFee(pair: LnPair, amountSat: bigint): bigint {
  const bp = BigInt(Math.round(pair.percentage * 10_000));
  return (amountSat * bp + 999_999n) / 1_000_000n + BigInt(pair.minerFees);
}

/** Pairs that can carry `amountSat`, cheapest first. */
export function lnPairsFor(pairs: readonly LnPair[], amountSat: bigint): LnPair[] {
  return pairs
    .filter((p) => amountSat >= BigInt(p.minimal) && amountSat <= BigInt(p.maximal))
    .sort((a, b) => Number(lnProviderFee(a, amountSat) - lnProviderFee(b, amountSat)));
}

/** Same shape as Rust's `LnSwapTerms`. */
export interface LnSwapTerms {
  id: string;
  address: string;
  expectedAmount: number;
  claimPublicKey: string;
  claimLeaf: string;
  refundLeaf: string;
  timeoutBlockHeight: number;
}

interface SwapAnswer {
  id?: unknown;
  address?: unknown;
  expectedAmount?: unknown;
  claimPublicKey?: unknown;
  timeoutBlockHeight?: unknown;
  swapTree?: { claimLeaf?: { version?: unknown; output?: unknown }; refundLeaf?: { version?: unknown; output?: unknown } };
}

const refuse = (name: string, why: string): never => {
  throw new Error(`${name} : ${why}`);
};

/** Reads `POST /v2/swap/submarine`. Throws on anything but the expected shape and fee. */
export function parseLnSwap(pair: LnPair, a: SwapAnswer, amountSat: bigint): LnSwapTerms {
  const name = pair.provider.name;
  const { id, address, expectedAmount, claimPublicKey, timeoutBlockHeight, swapTree: tree } = a;
  const claim = tree?.claimLeaf;
  const rf = tree?.refundLeaf;
  if (typeof id !== 'string' || typeof address !== 'string' || typeof claimPublicKey !== 'string' || !posInt(expectedAmount) || !posInt(timeoutBlockHeight)) return refuse(name, l10n('réponse illisible', 'unreadable response'));
  if (claim?.version !== 192 || rf?.version !== 192 || typeof claim.output !== 'string' || typeof rf.output !== 'string') return refuse(name, l10n('scripts illisibles', 'unreadable scripts'));
  if (BigInt(expectedAmount) !== amountSat + lnProviderFee(pair, amountSat)) return refuse(name, l10n('montant différent des frais annoncés', 'amount differs from the fees announced'));
  return { id, address, expectedAmount, claimPublicKey, claimLeaf: claim.output, refundLeaf: rf.output, timeoutBlockHeight };
}

/** A provider's refusal as it worded it (bounded), or the error as is. */
export function lnErrorText(e: unknown): string {
  if (e instanceof HttpError) {
    try {
      const m = (JSON.parse(e.body) as { error?: unknown }).error;
      if (typeof m === 'string') return m.slice(0, 120);
    } catch {
      /* not JSON */
    }
  }
  return e instanceof Error ? e.message.slice(0, 160) : String(e);
}

export async function lnCreateSwap(fetcher: NetFetch, pair: LnPair, invoice: string, refundPublicKey: string, amountSat: bigint): Promise<LnSwapTerms> {
  const body = { from: 'BTC', to: 'BTC', invoice, refundPublicKey, pairHash: pair.hash };
  const a = await fetchJson<SwapAnswer>(fetcher, `${pair.provider.api}/v2/swap/submarine`, { method: 'POST', body });
  return parseLnSwap(pair, a, amountSat);
}

const PAID = new Set(['invoice.paid', 'transaction.claim.pending', 'transaction.claimed']);
const FAILED = new Set(['invoice.failedToPay', 'transaction.lockupFailed', 'swap.expired', 'invoice.expired']);

/** A provider's status in the history's words. */
export function lnStatusOf(status: string): 'SUCCESS' | 'FAILED' | 'PROCESSING' {
  return PAID.has(status) ? 'SUCCESS' : FAILED.has(status) ? 'FAILED' : 'PROCESSING';
}

export const lnBridgeOf = (id: LnProviderId): string => `ln${id}`;
export const lnProviderOfBridge = (bridge: string): LnProvider | undefined => LN_PROVIDERS.find((p) => lnBridgeOf(p.id) === bridge);

export async function lnSwapStatus(fetcher: NetFetch, provider: LnProvider, id: string): Promise<{ status: string; receivingTxHash?: string }> {
  if (!/^[A-Za-z0-9]{1,64}$/.test(id)) throw new Error(l10n('Identifiant d’échange invalide', 'Invalid swap id'));
  const r = await fetchJson<{ status?: unknown }>(fetcher, `${provider.api}/v2/swap/${id}`);
  return { status: lnStatusOf(typeof r.status === 'string' ? r.status : '') };
}

/** Kyro's service fee on the on-chain deposit, rounded up, never under what can relay. */
export function lnKyroFee(expectedSat: bigint, bps: number): bigint {
  if (bps <= 0) return 0n;
  const fee = (expectedSat * BigInt(bps) + 9_999n) / 10_000n;
  return fee < LN_MIN_KYRO_FEE_SAT ? LN_MIN_KYRO_FEE_SAT : fee;
}

/** Does this text look like an invoice? Rust decides; this only opens the Lightning view. */
export function looksLikeInvoice(s: string): boolean {
  return /^(lightning:)?ln(bc|tb|tbs|bcrt)[0-9]/i.test(s.trim());
}
