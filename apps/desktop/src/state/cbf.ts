// SPDX-License-Identifier: GPL-3.0-or-later
// Compact block filters (BIP157/158), UI side.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { call, ipcErrorIn, onCbfStatus, toIpcError, type CbfStatus, type Unlisten } from '@kyro/shared';
import { t } from '../i18n';

export type CbfAvailability = 'unknown' | 'available' | 'disabled';

export interface CbfSnapshot {
  availability: CbfAvailability;
  status: CbfStatus | null;
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
  start(): Promise<void>;
  stop(): void;
  refresh(): Promise<void>;
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

/** Short label of a sync phase (current language). */
export function cbfPhaseLabel(s: CbfStatus): string {
  switch (s.state) {
    case 'idle':
      return t('shell.cbfIdle');
    case 'connecting':
      return t('shell.cbfConnecting');
    case 'headers':
      return t('shell.cbfHeaders');
    case 'filters':
      return t('shell.cbfFilters');
    case 'synced':
      return t('shell.cbfSynced');
    case 'error':
      return t('shell.cbfError');
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
