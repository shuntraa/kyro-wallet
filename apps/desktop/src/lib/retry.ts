// SPDX-License-Identifier: GPL-3.0-or-later
// Balance refresh cadence: the regular poll, and the faster retries after a failure.

export const BALANCE_REFRESH_MS = 30_000;

/** Delay before re-trying chains that failed, after `failures` refreshes in a row with errors (5 s, 10 s, 20 s, then the regular poll). */
export function balanceRetryDelay(failures: number): number | null {
  if (failures <= 0) return null;
  const ms = 5_000 * 2 ** (failures - 1);
  return ms < BALANCE_REFRESH_MS ? ms : null;
}
