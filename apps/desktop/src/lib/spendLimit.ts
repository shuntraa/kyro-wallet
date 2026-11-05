// SPDX-License-Identifier: GPL-3.0-or-later
// Daily spending limit: what the screens decide. Rust enforces it (spend_limit.rs): nothing here
// can let a send through, this only picks what to show.

import { call, type Currency, type SpendLimitConfig, type SpendLimitExceeded, type SpendLimitStatus } from '@kyro/shared';

export const WAIT_HOUR = 3_600;
export const WAIT_DAY = 86_400;

/** What the override area shows. */
export type OverrideStep = 'request' | 'waiting' | 'confirm' | 'open';

export function overrideStep(status: Pick<SpendLimitStatus, 'override'>): OverrideStep {
  switch (status.override?.phase) {
    case 'waiting':
      return 'waiting';
    case 'ready':
      return 'confirm';
    case 'open':
      return 'open';
    default:
      return 'request';
  }
}

/** The form's amount, or null when it cannot be a limit. */
export function parseLimitAmount(raw: string): number | null {
  const n = Number(raw.trim().replace(',', '.'));
  return raw.trim() !== '' && Number.isFinite(n) && n > 0 && n <= 1e15 ? n : null;
}

/**
 * Same rule as `Limit::configure`, to say before the password whether a change applies now.
 * `null` = off. A new currency cannot be compared, so it waits.
 */
export function changeTiming(current: SpendLimitConfig | null, next: SpendLimitConfig | null): 'now' | 'wait' {
  if (!current) return 'now';
  if (!next) return 'wait';
  return next.currency === current.currency && next.amount <= current.amount && next.waitSecs >= current.waitSecs ? 'now' : 'wait';
}

/** `2 h 05 min`, `12 min`, or `< 1 min`. */
export function fmtTimeLeft(secs: number): string {
  if (secs <= 0) return '0 min';
  if (secs < 60) return '< 1 min';
  const mins = Math.ceil(secs / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

/** Share of the limit used, 0 to 1, for the bar. A limit of zero (damaged file) reads as full. */
export function usedShare(spent: number, limit: number): number {
  return limit > 0 ? Math.min(1, Math.max(0, spent / limit)) : 1;
}

/** Reads the data of a `SPEND_LIMIT` error; anything malformed is treated as an unknown amount. */
export function readExceeded(data: unknown, fallback: Currency): SpendLimitExceeded {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Partial<SpendLimitExceeded>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { spent: num(d.spent) ?? 0, limit: num(d.limit) ?? 0, amount: num(d.amount), currency: d.currency ?? fallback };
}

/**
 * Swap only, right before its signature: Rust cannot read aggregator calldata, so it is told what
 * those exact bytes sell. Rust prices it from its own tables (docs/IPC.md §2.13).
 */
export function declareSwap(chain: string, payload: string, contract: string | undefined, amount: bigint): Promise<void> {
  return call('spend_limit_declare', { chain, payload, contract: contract ?? null, amount: amount.toString() });
}
