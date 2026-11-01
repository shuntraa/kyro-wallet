// SPDX-License-Identifier: GPL-3.0-or-later
// Embedded Tor, UI side. One store for the whole app, started once in main.tsx.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { call, onIpcError, onTorStatus, toIpcError, torRetry, type CommandName, type IpcError, type TorStatus, type Unlisten } from '@kyro/shared';

export type TorDialog = 'none' | 'failure' | 'confirm-direct';
/** What the status bar shows. `direct` = Tor disabled by the user (never styled as protected). */
export type TorIndicator = 'unknown' | 'bootstrapping' | 'ready' | 'failed' | 'direct';

export interface TorEpisode {
  reason: string | null;
}

export interface TorSnapshot {
  status: TorStatus | null;
  enabled: boolean | null;
  dialog: TorDialog;
  /** Where the "continue without Tor" confirmation was opened from (its Cancel goes back there). */
  confirmFrom: 'failure' | 'settings' | null;
  /** Failure in progress. Opened by `error` / TOR_UNAVAILABLE; closed by `ready`, a new bootstrap, or disabling Tor. */
  episode: TorEpisode | null;
  busy: boolean;
  actionError: string | null;
}

export interface TorStoreDeps {
  fetchStatus: () => Promise<TorStatus>;
  retry: () => Promise<TorStatus>;
  listen: (cb: (s: TorStatus) => void) => Promise<Unlisten>;
  onIpcError: (cb: (cmd: CommandName, e: IpcError) => void) => () => void;
}

export interface TorStore {
  getSnapshot(): TorSnapshot;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  stop(): void;
  setEnabled(enabled: boolean): void;
  reportUnavailable(message: string | null): void;
  /** Status bar click on "Tor indisponible". */
  openFailure(): void;
  cancel(): void;
  retry(): Promise<void>;
  /** "Continuer sans Tor" / settings switch turned off: ask the explicit confirmation. Saves nothing. */
  requestDisable(from: 'failure' | 'settings'): void;
  cancelDisable(): void;
  confirmDisable(save: () => Promise<void>): Promise<void>;
  enable(save: () => Promise<void>): Promise<void>;
}

const INITIAL: TorSnapshot = { status: null, enabled: null, dialog: 'none', confirmFrom: null, episode: null, busy: false, actionError: null };

export function createTorStore(deps: TorStoreDeps): TorStore {
  let snap: TorSnapshot = INITIAL;
  const listeners = new Set<() => void>();
  let started: Promise<void> | null = null;
  let unlisten: Unlisten | null = null;
  let unError: (() => void) | null = null;
  let stopped = false;
  /** Bumped by every event, so a slower `tor_status` answer never overwrites a newer event. */
  let eventSeq = 0;

  const set = (patch: Partial<TorSnapshot>) => {
    snap = { ...snap, ...patch };
    listeners.forEach((l) => l());
  };

  const beginEpisode = (reason: string | null) => {
    if (snap.enabled === false) return; // Tor off by choice: nothing to report.
    if (snap.episode) {
      if (!snap.episode.reason && reason) set({ episode: { reason } });
      return; // Same episode: never spam the dialog.
    }
    set({ episode: { reason }, dialog: snap.dialog === 'confirm-direct' ? snap.dialog : 'failure', actionError: null });
  };

  const applyStatus = (next: TorStatus) => {
    const prev = snap.status;
    if (next.state === 'ready') {
      const closeDialog = snap.dialog === 'failure' || (snap.dialog === 'confirm-direct' && snap.confirmFrom === 'failure');
      set({ status: next, episode: null, ...(closeDialog ? { dialog: 'none', confirmFrom: null, actionError: null } : {}) });
      return;
    }
    if (next.state === 'bootstrapping' && prev?.state !== 'bootstrapping') {
      set({ status: next, episode: null });
      return;
    }
    set({ status: next });
    if (next.state === 'error') beginEpisode(next.message ?? null);
  };

  const store: TorStore = {
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      started ??= (async () => {
        stopped = false;
        unError = deps.onIpcError((_cmd, e) => {
          if (e.code === 'TOR_UNAVAILABLE') store.reportUnavailable(e.message);
        });
        // Listen first, then read the current state: a `ready` emitted before the UI subscribed is
        // in the snapshot, and nothing emitted after is lost.
        const un = await deps.listen((s) => {
          eventSeq += 1;
          applyStatus(s);
        });
        if (stopped) {
          un();
          return;
        }
        unlisten = un;
        const seq = eventSeq;
        try {
          const current = await deps.fetchStatus();
          if (eventSeq === seq) applyStatus(current);
        } catch {
          /* the next event will tell */
        }
      })();
      return started;
    },
    stop() {
      stopped = true;
      unlisten?.();
      unError?.();
      unlisten = null;
      unError = null;
      started = null;
    },
    setEnabled(enabled) {
      if (enabled === snap.enabled) return;
      if (!enabled) {
        set({ enabled, episode: null, dialog: 'none', confirmFrom: null, actionError: null });
        return;
      }
      set({ enabled });
      if (snap.status?.state === 'error') beginEpisode(snap.status.message ?? null);
    },
    reportUnavailable(message) {
      beginEpisode(message);
    },
    openFailure() {
      set({ dialog: 'failure', confirmFrom: null, actionError: null });
    },
    cancel() {
      set({ dialog: 'none', confirmFrom: null, actionError: null });
    },
    async retry() {
      set({ busy: true, actionError: null });
      try {
        const s = await deps.retry();
        set({ busy: false, dialog: 'none', confirmFrom: null });
        applyStatus(s);
      } catch (e) {
        set({ busy: false, actionError: toIpcError(e).message });
      }
    },
    requestDisable(from) {
      set({ dialog: 'confirm-direct', confirmFrom: from, actionError: null });
    },
    cancelDisable() {
      set({ dialog: snap.confirmFrom === 'failure' ? 'failure' : 'none', confirmFrom: null, actionError: null });
    },
    async confirmDisable(save) {
      if (snap.dialog !== 'confirm-direct') return; // only from the explicit confirmation
      set({ busy: true, actionError: null });
      try {
        await save();
        set({ busy: false });
        store.setEnabled(false);
      } catch (e) {
        set({ busy: false, actionError: toIpcError(e).message });
      }
    },
    async enable(save) {
      set({ busy: true, actionError: null });
      try {
        await save();
        set({ busy: false });
        store.setEnabled(true);
      } catch (e) {
        set({ busy: false, actionError: toIpcError(e).message });
      }
    },
  };
  return store;
}

export function torIndicator(s: TorSnapshot): TorIndicator {
  if (s.enabled === false) return 'direct';
  if (!s.status) return 'unknown';
  switch (s.status.state) {
    case 'ready':
      return 'ready';
    case 'error':
      return 'failed';
    case 'bootstrapping':
      return s.episode ? 'failed' : 'bootstrapping';
    case 'off':
      // Transitional (just re-enabled, the bootstrap event is on its way) unless requests already failed.
      return s.episode ? 'failed' : 'unknown';
  }
}

/** True while network data cannot load because Tor (enabled) is not ready. */
export function torWaiting(s: TorSnapshot): boolean {
  return s.enabled !== false && s.status?.state !== 'ready';
}

/** Shell detail without the redundant « Tor indisponible : » / "Tor unavailable:" prefix(es). */
export function torDetail(message: string | null | undefined): string | null {
  if (!message) return null;
  const m = message.replace(/^(\s*Tor (?:indisponible|unavailable)\s*:\s*)+/i, '').trim();
  return m || null;
}

export const torStore: TorStore = createTorStore({
  fetchStatus: () => call('tor_status'),
  retry: torRetry,
  listen: onTorStatus,
  onIpcError,
});

export function useTor(): TorSnapshot {
  return useSyncExternalStore(torStore.subscribe, torStore.getSnapshot);
}

/** Runs `cb` when Tor becomes ready (bootstrap done, retry, re-enable): reload now, not at the next poll. */
export function useOnTorReady(cb: () => void): void {
  const ready = useTor().status?.state === 'ready';
  const prev = useRef(ready);
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    if (ready && !prev.current) cbRef.current();
    prev.current = ready;
  }, [ready]);
}
