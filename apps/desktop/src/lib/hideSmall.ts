// SPDX-License-Identifier: GPL-3.0-or-later
// Réglages › Affichage › « Masquer les petits soldes »: which holdings stay out of the Portfolio
// ring and of « Mes actifs ». Search and the market tab still show them.

import type { HideSmall } from '@kyro/shared';

/** Threshold in the display currency (strictly below is hidden). */
const LIMIT: Record<Exclude<HideSmall, 'off'>, number> = { zero: 0, under1: 1, under10: 10 };

/**
 * `true` = left out. An empty holding goes with every option but `off`; a holding without a
 * price is kept (its worth is unknown, it is never taken for « small »).
 */
export function hiddenAsSmall(h: { amount: bigint; value: number | null }, pref: HideSmall | undefined): boolean {
  if (!pref || pref === 'off') return false;
  if (h.amount <= 0n) return true;
  const limit = LIMIT[pref];
  if (limit === undefined || limit === 0) return false;
  return h.value !== null && Number.isFinite(h.value) && h.value < limit;
}

/** The rows shown: everything while searching, else without the small ones. */
export function withoutSmall<T extends { amount: bigint; value: number | null }>(rows: T[], pref: HideSmall | undefined, query = ''): T[] {
  return query.trim() ? rows : rows.filter((h) => !hiddenAsSmall(h, pref));
}
