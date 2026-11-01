// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — simulated embedded Tor, mirroring apps/desktop/src-tauri/src/tor.rs:
// `off` → `bootstrapping` (0..99) → `ready` (100) or `error` (message), one
// `tor-status` event per change, and a fail-closed gate for `net_fetch`
// (waits for an in-progress bootstrap, then `TOR_UNAVAILABLE`; never in clear).
//
// Scenarios (demo URL `?tor=…`, or `MockOptions.tor` in tests):
//   - `bootstrap` (default in a browser): ~2 s of progress, then `ready`;
//   - `fail`: every bootstrap fails at ~35 % (Retry fails too);
//   - `fail-once`: the first bootstrap fails, the next one (Retry) succeeds;
//   - `ready` (default without `window`, i.e. unit tests): ready at once, no timers.

import { IpcError, type TorStatus } from './ipc';
import { emitDemoEvent } from './events';
import { l10n } from './i18n';

export type DemoTorScenario = 'bootstrap' | 'ready' | 'fail' | 'fail-once';

/** Duration of a simulated bootstrap. */
export const DEMO_TOR_BOOTSTRAP_MS = 2000;
/** Same bound as `READY_WAIT` in tor.rs. */
export const DEMO_TOR_READY_WAIT_MS = 60_000;
const STEP_MS = 100;
const FAIL_AT = 35;
export const demoTorFailure = (): string => l10n('aucun relais Tor joignable (simulation du mode démo)', 'no Tor relay reachable (demo mode simulation)');

export interface DemoTor {
  status(): TorStatus;
  /** Starts unless already bootstrapping or ready (`TorManager::start`). */
  start(): void;
  /** (Re)starts from scratch (`tor_retry`). */
  restart(): void;
  /** Tor disabled by the user: `off`. */
  stop(): void;
  /** Gate of `net_fetch` over Tor: resolves once ready, rejects with `TOR_UNAVAILABLE` otherwise. */
  waitReady(): Promise<void>;
}

const unavailable = (why: string) => new IpcError('TOR_UNAVAILABLE', l10n(`Tor indisponible : ${why}`, `Tor unavailable: ${why}`));

export function createDemoTor(scenario: DemoTorScenario): DemoTor {
  let status: TorStatus = { state: 'off', progress: 0 };
  let generation = 0;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const waiters = new Set<() => void>();

  const publish = (next: TorStatus) => {
    status = next;
    emitDemoEvent('tor-status', { ...next });
    [...waiters].forEach((w) => w());
  };

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const restart = () => {
    clear();
    const gen = ++generation;
    attempts += 1;
    if (scenario === 'ready') {
      publish({ state: 'ready', progress: 100 });
      return;
    }
    const fails = scenario === 'fail' || (scenario === 'fail-once' && attempts === 1);
    publish({ state: 'bootstrapping', progress: 0 });
    const steps = DEMO_TOR_BOOTSTRAP_MS / STEP_MS;
    let i = 0;
    const tick = () => {
      timer = null;
      if (gen !== generation) return;
      i += 1;
      const progress = Math.round((i / steps) * 100);
      if (fails && progress >= FAIL_AT) {
        publish({ state: 'error', progress: 0, message: demoTorFailure() });
        return;
      }
      if (progress >= 100) {
        publish({ state: 'ready', progress: 100 });
        return;
      }
      publish({ state: 'bootstrapping', progress: Math.min(progress, 99), message: progress < 50 ? l10n('connexion au réseau Tor', 'connecting to the Tor network') : l10n('construction des circuits', 'building circuits') });
      timer = setTimeout(tick, STEP_MS);
    };
    timer = setTimeout(tick, STEP_MS);
  };

  return {
    status: () => ({ ...status }),
    start() {
      if (status.state === 'bootstrapping' || status.state === 'ready') return;
      restart();
    },
    restart,
    stop() {
      clear();
      generation += 1;
      publish({ state: 'off', progress: 0 });
    },
    waitReady: () =>
      new Promise<void>((resolve, reject) => {
        let deadline: ReturnType<typeof setTimeout> | null = null;
        const settle = (): boolean => {
          switch (status.state) {
            case 'bootstrapping':
              return false;
            case 'ready':
              resolve();
              break;
            case 'off':
              reject(unavailable(l10n('Tor n’est pas démarré', 'Tor is not started')));
              break;
            case 'error':
              reject(unavailable(status.message ?? l10n('échec du démarrage', 'startup failed')));
              break;
          }
          return true;
        };
        if (settle()) return;
        const waiter = () => {
          if (!settle()) return;
          waiters.delete(waiter);
          if (deadline !== null) clearTimeout(deadline);
        };
        waiters.add(waiter);
        deadline = setTimeout(() => {
          waiters.delete(waiter);
          reject(unavailable(l10n('délai de démarrage dépassé', 'startup timed out')));
        }, DEMO_TOR_READY_WAIT_MS);
      }),
  };
}

/** Scenario from the demo URL (`?tor=fail`, `?tor=fail-once`, `?tor=ready`); `ready` outside a browser. */
export function detectDemoTorScenario(): DemoTorScenario {
  if (typeof window === 'undefined') return 'ready';
  try {
    const q = new URLSearchParams(window.location.search).get('tor');
    if (q === 'fail' || q === 'fail-once' || q === 'ready') return q;
  } catch {
    /* ignore */
  }
  return 'bootstrap';
}

/** `?tor=off` starts the demo with Tor disabled in the settings (direct connection). */
export function detectDemoTorDisabled(): boolean {
  try {
    return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('tor') === 'off';
  } catch {
    return false;
  }
}
