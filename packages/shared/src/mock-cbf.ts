// SPDX-License-Identifier: GPL-3.0-or-later
// DEMO ONLY — compact block filters (BIP157/158), mirroring the `cbf` cargo feature of

import { IpcError, type CbfStatus, type Network } from './ipc';
import { emitDemoEvent } from './events';
import type { DemoTor } from './mock-tor';
import { l10n } from './i18n';

export const DEMO_CBF_CONNECT_MS = 600;
export const DEMO_CBF_HEADERS_MS = 2000;
export const DEMO_CBF_FILTERS_MS = 4000;
const TICK_MS = 500;
/** Reads trigger a background sync when the last one is older than this (Rust: 2 min). */
const STALE_SECS = 120;

export const cbfDisabled = () => new IpcError('FEATURE_DISABLED', l10n('Fonction désactivée : filtres compacts (BIP157/158) : disponible après revue (>= 2026-11-11)', 'Feature disabled: compact filters (BIP157/158): available after review (>= 2026-11-11)'));

const onion = (seed: string) => `${seed.repeat(56).slice(0, 56)}.onion`;
const DEFAULT_PEERS: Record<Network, { onion: string[]; ip: string[] }> = {
  testnet: { onion: [onion('kyrodemoa'), onion('kyrodemob'), onion('kyrodemoc')].map((h) => `${h}:48333`), ip: ['203.0.113.10:48333', '198.51.100.7:48333'] },
  mainnet: { onion: [onion('kyrodemod'), onion('kyrodemoe'), onion('kyrodemof')].map((h) => `${h}:8333`), ip: ['203.0.113.20:8333', '198.51.100.9:8333'] },
};

export interface DemoCbfDeps {
  enabled: boolean;
  network: Network;
  tor: DemoTor;
  torOn: () => boolean;
  tipHeight: () => number;
  /** The active CBF server of this network, or null when Bitcoin is not in CBF mode. */
  server: () => { peers?: string[]; birthHeight?: number } | null;
  requireUnlocked: () => void;
}

export interface DemoCbf {
  readonly enabled: boolean;
  status(): CbfStatus;
  sync(): CbfStatus;
  /** Reads: never block, but start a background sync when stale (or never synced). */
  refreshIfStale(): void;
  synced(): boolean;
}

export function createDemoCbf(d: DemoCbfDeps): DemoCbf {
  let st: CbfStatus = { state: 'idle', tipHeight: null, scannedHeight: null, birthHeight: 0, progress: 0, peers: [], tor: d.torOn(), lastSyncUnix: null, watchedScripts: 0, matchedBlocks: 0 };
  let running = false;

  const publish = (patch: Partial<CbfStatus>) => {
    st = { ...st, ...patch };
    emitDemoEvent('cbf-status', structuredClone(st));
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const run = async () => {
    running = true;
    const server = d.server() ?? {};
    const tor = d.torOn();
    const birth = server.birthHeight ?? 0;
    const tip = d.tipHeight();
    const own = server.peers ?? [];
    const { message: _previous, ...clean } = st;
    st = clean;
    publish({ state: 'connecting', tor, birthHeight: birth, progress: 0, peers: [], watchedScripts: 40, matchedBlocks: 0 });
    try {
      // Tor only (fail closed): the P2P library can only go out through Tor when enabled.
      if (tor) await d.tor.waitReady();
      await wait(DEMO_CBF_CONNECT_MS);
      const peers = tor ? [...DEFAULT_PEERS[d.network].onion, ...own].slice(0, 4) : [...DEFAULT_PEERS[d.network].ip, ...own.filter((p) => !p.includes('.onion'))].slice(0, 4);
      const fromHeader = st.tipHeight ?? 0;
      const hSteps = Math.ceil(DEMO_CBF_HEADERS_MS / TICK_MS);
      for (let i = 1; i <= hSteps; i++) {
        await wait(TICK_MS);
        publish({ state: 'headers', peers, tipHeight: Math.round(fromHeader + ((tip - fromHeader) * i) / hSteps) });
      }
      // Resume from what was already scanned (a re-sync only reads the new filters).
      const from = Math.min(Math.max(birth, st.scannedHeight ?? birth), tip);
      const fSteps = Math.ceil(DEMO_CBF_FILTERS_MS / TICK_MS);
      for (let i = 1; i <= fSteps; i++) {
        await wait(TICK_MS);
        const progress = i / fSteps;
        publish({ state: 'filters', scannedHeight: Math.round(from + (tip - from) * progress), progress, matchedBlocks: Math.floor(progress * 4) });
      }
      publish({ state: 'synced', progress: 1, tipHeight: tip, scannedHeight: tip, lastSyncUnix: Math.floor(Date.now() / 1000) });
    } catch (e) {
      publish({ state: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      running = false;
    }
  };

  const start = () => {
    if (!running) void run();
  };

  return {
    enabled: d.enabled,
    status() {
      if (!d.enabled) throw cbfDisabled();
      return structuredClone(st);
    },
    sync() {
      if (!d.enabled) throw cbfDisabled();
      if (!d.server()) throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : le serveur Bitcoin n’est pas en mode filtres compacts', 'Invalid input: the Bitcoin server is not in compact-filter mode'));
      d.requireUnlocked();
      start();
      return structuredClone(st);
    },
    refreshIfStale() {
      const last = st.lastSyncUnix ?? null;
      if (!running && (last === null || Date.now() / 1000 - last > STALE_SECS)) {
        try {
          d.requireUnlocked();
          start();
        } catch {
          /* locked: the next read after unlock starts it */
        }
      }
    },
    synced: () => st.lastSyncUnix !== null && st.lastSyncUnix !== undefined,
  };
}

/** `?cbf=on` enables the simulated compact-filter mode in the demo. */
export function detectDemoCbf(): boolean {
  try {
    return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('cbf') === 'on';
  } catch {
    return false;
  }
}
