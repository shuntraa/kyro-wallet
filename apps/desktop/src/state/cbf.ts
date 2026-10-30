// SPDX-License-Identifier: GPL-3.0-or-later
//
// Compact block filters (BIP157/158), UI side. One store, subscribed once in main.tsx.
// - availability: `btc_cbf_status` answers FEATURE_DISABLED in a build without the `cbf`
//   cargo feature (today's default): the option stays visible but disabled;
// - status: the `cbf-status` event (at most 2/s), with `btc_cbf_status` for the current state.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { call, ipcErrorIn, onCbfStatus, toIpcError, type CbfStatus, type Unlisten } from '@kyro/shared';

export type CbfAvailability = 'unknown' | 'available' | 'disabled';

export interface CbfSnapshot {
  availability: CbfAvailability;
  status: CbfStatus | null;
  /** Last command error (other than FEATURE_DISABLED). */
  error: string | null;
}

export interface CbfStoreDeps {
  fetchStatus: () => Promise<CbfStatus>;
  sync: () => Promise<CbfStatus>;
  listen: (cb: (s: CbfStatus) => void) => Promise<Unlisten>;
}

export interface CbfStore {
  getSnapshot(): CbfSnapshot;
  subscribe(listener: () => void): () => void;
  /** Listens to `cbf-status` and reads the current state. Idempotent. */
  start(): Promise<void>;
  stop(): void;
  /** Re-reads `btc_cbf_status` (availability + status). */
  refresh(): Promise<void>;
  /** `btc_cbf_sync`: starts (or joins) a background sync. */
  sync(): Promise<void>;
}

export function createCbfStore(deps: CbfStoreDeps): CbfStore {
  let snap: CbfSnapshot = { availability: 'unknown', status: null, error: null };
  const listeners = new Set<() => void>();
  let started: Promise<void> | null = null;
  let unlisten: Unlisten | null = null;
  let eventSeq = 0;

  const set = (patch: Partial<CbfSnapshot>) => {
    snap = { ...snap, ...patch };
    listeners.forEach((l) => l());
  };

  const fail = (e: unknown) => {
    if (ipcErrorIn(e)?.code === 'FEATURE_DISABLED') set({ availability: 'disabled', status: null, error: null });
    else set({ error: toIpcError(e).message });
  };

  const store: CbfStore = {
    getSnapshot: () => snap,
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    start() {
      started ??= (async () => {
        unlisten = await deps.listen((s) => {
          eventSeq += 1;
          set({ status: s, availability: 'available', error: null });
        });
        await store.refresh();
      })();
      return started;
    },
    stop() {
      unlisten?.();
      unlisten = null;
      started = null;
    },
    async refresh() {
      const seq = eventSeq;
      try {
        const s = await deps.fetchStatus();
        // An event received meanwhile is newer than this answer.
        set({ availability: 'available', error: null, ...(eventSeq === seq ? { status: s } : {}) });
      } catch (e) {
        fail(e);
      }
    },
    async sync() {
      const seq = eventSeq;
      try {
        const s = await deps.sync();
        set({ availability: 'available', error: null, ...(eventSeq === seq ? { status: s } : {}) });
      } catch (e) {
        fail(e);
      }
    },
  };
  return store;
}

/** Short French label of a sync phase. */
export function cbfPhaseLabel(s: CbfStatus): string {
  switch (s.state) {
    case 'idle':
      return 'en attente';
    case 'connecting':
      return 'connexion aux pairs';
    case 'headers':
      return 'en-têtes';
    case 'filters':
      return 'filtres';
    case 'synced':
      return 'synchronisé';
    case 'error':
      return 'erreur';
  }
}

export const cbfStore: CbfStore = createCbfStore({
  fetchStatus: () => call('btc_cbf_status'),
  sync: () => call('btc_cbf_sync'),
  listen: onCbfStatus,
});

export function useCbf(): CbfSnapshot {
  return useSyncExternalStore(cbfStore.subscribe, cbfStore.getSnapshot);
}

/** Runs `cb` when a compact-filter sync completes: reload the data now, not at the next poll. */
export function useOnCbfSynced(cb: () => void): void {
  const synced = useCbf().status?.state === 'synced';
  const prev = useRef(synced);
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    if (synced && !prev.current) cbRef.current();
    prev.current = synced;
  }, [synced]);
}
