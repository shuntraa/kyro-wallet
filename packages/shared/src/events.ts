// SPDX-License-Identifier: GPL-3.0-or-later
//
// Events emitted by the shell (Rust → UI).
//   - `vault-locked` (no payload): the session was zeroized (auto-lock, sleep…).

import { isTauri } from './ipc';

export type ShellEvent = 'vault-locked';
export type Unlisten = () => void;

type Listener = () => void;
const demoListeners = new Map<ShellEvent, Set<Listener>>();

/** Used by the demo backend to emulate shell events. */
export function emitDemoEvent(name: ShellEvent): void {
  demoListeners.get(name)?.forEach((cb) => {
    try {
      cb();
    } catch {
      /* listener errors must not break the emitter */
    }
  });
}

/** Subscribe to a shell event. Resolves to an unsubscribe function. */
export async function listenShell(name: ShellEvent, cb: Listener): Promise<Unlisten> {
  if (isTauri()) {
    const { listen } = await import('@tauri-apps/api/event');
    return listen(name, () => cb());
  }
  let set = demoListeners.get(name);
  if (!set) {
    set = new Set();
    demoListeners.set(name, set);
  }
  set.add(cb);
  return () => set.delete(cb);
}
