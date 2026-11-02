// SPDX-License-Identifier: GPL-3.0-or-later
// Last technical error per chain and source (history, balances), kept in memory only and shown in
// Settings › Network diagnostics. The rest of the UI shows a calm sentence, never this raw text.

import { useSyncExternalStore } from 'react';

export type NetErrorSource = 'history' | 'balances';
export interface NetErrorEntry {
  source: NetErrorSource;
  chainKey: string;
  message: string;
  at: number;
}

let entries: NetErrorEntry[] = [];
const listeners = new Set<() => void>();

/** Replaces the errors of `source` with `errors` (chain key → technical message). */
export function recordNetErrors(source: NetErrorSource, errors: Record<string, string>, now = Date.now()): void {
  const kept = entries.filter((e) => e.source !== source);
  const added = Object.entries(errors).map(([chainKey, message]) => ({ source, chainKey, message, at: now }));
  if (added.length === 0 && kept.length === entries.length) return;
  entries = [...kept, ...added];
  listeners.forEach((l) => l());
}

export function getNetErrors(): NetErrorEntry[] {
  return entries;
}

export function useNetErrors(): NetErrorEntry[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getNetErrors,
    getNetErrors,
  );
}
