// SPDX-License-Identifier: GPL-3.0-or-later
//
// MODE DÉMO — network choice (docs/IPC.md §2.10), mirroring src-tauri/src/network.rs:
// `?network=` in the URL plays the role of KYRO_NETWORK (forces it, switching refused), then
// the saved choice (localStorage, public data), then the default (testnet, like a debug build).
// `network_set` saves and « restarts »: in a browser, the page reloads without `?network=`.

import { IpcError, type Network, type NetworkInfo, type NetworkSource } from './ipc';
import { l10n } from './i18n';

export const DEMO_NETWORK_STORAGE_KEY = 'kyro.demo.network';
/** The demo behaves like a debug build. */
export const DEMO_DEFAULT_NETWORK: Network = 'testnet';

export interface DemoNetworkStore {
  get(): Network | null;
  set(n: Network): void;
}

function parseNetwork(v: unknown): Network | null {
  if (typeof v !== 'string') return null;
  const n = v.trim().toLowerCase();
  return n === 'mainnet' || n === 'testnet' ? n : null;
}

/** localStorage-backed store (in memory when there is no storage: tests, private windows). */
export function demoNetworkStore(): DemoNetworkStore {
  let memory: Network | null = null;
  return {
    get() {
      try {
        if (typeof localStorage !== 'undefined') return parseNetwork(localStorage.getItem(DEMO_NETWORK_STORAGE_KEY));
      } catch {
        /* storage blocked */
      }
      return memory;
    },
    set(n) {
      memory = n;
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(DEMO_NETWORK_STORAGE_KEY, n);
      } catch {
        /* storage blocked: kept in memory */
      }
    },
  };
}

/** Same precedence as Rust's `network::resolve` (no `vault` step: the demo vault lives in memory). */
export function resolveDemoNetwork(forced: string | null | undefined, saved: Network | null): { network: Network; source: NetworkSource } {
  const f = parseNetwork(forced);
  if (f) return { network: f, source: 'env' };
  if (saved) return { network: saved, source: 'saved' };
  return { network: DEMO_DEFAULT_NETWORK, source: 'default' };
}

/** `?network=` of the page URL, if any. */
export function demoNetworkParam(): string | null {
  try {
    if (typeof window !== 'undefined') return new URLSearchParams(window.location.search).get('network');
  } catch {
    /* ignore */
  }
  return null;
}

/** Browser « restart »: reload the page without `?network=` so the saved choice applies. */
function reloadPage(): void {
  if (typeof window === 'undefined') return;
  window.setTimeout(() => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('network');
      window.location.replace(url.toString());
    } catch {
      window.location.reload();
    }
  }, 50);
}

export interface DemoNetworkDeps {
  network: Network;
  source: NetworkSource;
  store: DemoNetworkStore;
  /** Locks the demo vault before the restart (like Rust's `lock_session`). */
  lock: () => void;
  /** Called instead of reloading the page (tests). */
  onRestart?: (n: Network) => void;
}

export function createDemoNetwork(deps: DemoNetworkDeps) {
  const info = (): NetworkInfo => ({
    network: deps.network,
    source: deps.source,
    saved: deps.store.get(),
    default: DEMO_DEFAULT_NETWORK,
    canSwitch: deps.source !== 'env',
    otherVaultExists: false,
  });
  return {
    handlers: {
      network_get: (): NetworkInfo => info(),
      network_set: (a: Record<string, unknown>): boolean => {
        const n = parseNetwork(a.network);
        if (!n) throw new IpcError('INVALID_INPUT', l10n(`Entrée invalide : réseau inconnu « ${String(a.network)} » (mainnet ou testnet)`, `Invalid input: unknown network “${String(a.network)}” (mainnet or testnet)`));
        if (deps.source === 'env') {
          throw new IpcError('INVALID_INPUT', l10n('Entrée invalide : le réseau est imposé par l’adresse de la page (?network=) : retire-la pour choisir depuis l’application', 'Invalid input: the network is forced by the page address (?network=): remove it to choose from the app'));
        }
        deps.store.set(n);
        if (n === deps.network) return false;
        deps.lock();
        if (deps.onRestart) deps.onRestart(n);
        else reloadPage();
        return true;
      },
    },
  };
}
