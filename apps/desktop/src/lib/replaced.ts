// SPDX-License-Identifier: GPL-3.0-or-later
// After a speed-up or a cancel, two transactions compete for the same coins or nonce and only one
// confirms. The history shows the one that matters.

import { addLocalTx, getLocalTxs, updateLocalTx, type LocalTx } from './storage';

/** Transaction id without what the history adds to it (`@account`, `:log`). */
export const baseTxId = (id: string): string => id.split(/[:@]/)[0] ?? id;

/**
 * A replaced transaction leaves the list while it lost or may still lose; if it confirmed after
 * all, it stays and its replacement is the one that failed.
 */
export function reconcileReplaced<T extends { id: string; status: string }>(items: readonly T[], locals: ReadonlyArray<Pick<LocalTx, 'id' | 'replaces' | 'replacedBy'>>): T[] {
  const replaced = new Set(locals.filter((t) => t.replacedBy).map((t) => t.id));
  if (replaced.size === 0) return [...items];
  const won = new Set(items.filter((x) => x.status === 'confirmed' && replaced.has(baseTxId(x.id))).map((x) => baseTxId(x.id)));
  const replacementOf = new Map(locals.flatMap((t) => (t.replaces ? [[t.id, t.replaces] as const] : [])));
  return items
    .filter((x) => !replaced.has(baseTxId(x.id)) || won.has(baseTxId(x.id)))
    .map((x) => {
      const original = replacementOf.get(baseTxId(x.id));
      return original && won.has(original) && x.status === 'pending' ? { ...x, status: 'failed' } : x;
    });
}

export interface ReplacedTx {
  network: LocalTx['network'];
  id: string;
  chainKey: string;
  assetId: string;
  kind: string;
  direction: string;
  amount: bigint;
  fee?: bigint;
  counterparty?: string;
  label?: string;
}

/** Records a broadcast replacement and links it to the transaction it replaces. */
export function recordReplacement(e: ReplacedTx, newId: string, change: { cancel: boolean; fee: bigint; label: string }, now = Date.now()): void {
  const oldId = baseTxId(e.id);
  const kept = getLocalTxs(e.network).find((t) => t.id === oldId);
  const base: LocalTx = kept ?? {
    id: oldId,
    network: e.network,
    chainKey: e.chainKey,
    assetId: e.assetId,
    kind: e.kind === 'swap' || e.kind === 'approval' ? e.kind : 'transfer',
    direction: e.direction === 'self' ? 'self' : 'out',
    amount: e.amount.toString(),
    time: now,
    status: 'pending',
    ...(e.fee !== undefined ? { fee: e.fee.toString() } : {}),
    ...(e.counterparty ? { counterparty: e.counterparty } : {}),
    ...(e.label ? { label: e.label } : {}),
  };
  if (kept) updateLocalTx(e.network, oldId, { replacedBy: newId });
  else addLocalTx({ ...base, replacedBy: newId });
  const { replacedBy: _old, cross, ...rest } = base;
  addLocalTx({
    ...rest,
    ...(change.cancel ? { kind: 'transfer' as const, direction: 'self' as const, amount: '0', label: change.label } : cross ? { cross } : {}),
    id: newId,
    replaces: oldId,
    fee: change.fee.toString(),
    time: now,
    status: 'pending',
  });
}
