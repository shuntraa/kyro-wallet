// SPDX-License-Identifier: GPL-3.0-or-later
//
// Events emitted by the shell (Rust → UI).
//   - `vault-locked` (no payload): the session was zeroized (auto-lock, sleep…).
//   - `tor-status` (`TorStatus`): every state or bootstrap-progress change of the embedded Tor.
//   - `cbf-status` (`CbfStatus`): compact-filter sync progress (at most 2 per second).
//   - `hw-prompt` (`HwPrompt`): what to tell the user during a hardware-wallet call.

import { isTauri, type CbfStatus, type HwPrompt, type TorStatus } from './ipc';

/** Payload of each shell event (`undefined` = none). */
export interface ShellEventPayloads {
  'vault-locked': undefined;
  'tor-status': TorStatus;
  'cbf-status': CbfStatus;
  'hw-prompt': HwPrompt;
}

export type ShellEvent = keyof ShellEventPayloads;
export type Unlisten = () => void;

type Listener<E extends ShellEvent> = (payload: ShellEventPayloads[E]) => void;
type PayloadArgs<E extends ShellEvent> = ShellEventPayloads[E] extends undefined ? [] : [payload: ShellEventPayloads[E]];

const demoListeners = new Map<ShellEvent, Set<(payload: unknown) => void>>();

/** Used by the demo backend to emulate shell events. */
export function emitDemoEvent<E extends ShellEvent>(name: E, ...args: PayloadArgs<E>): void {
  const payload = args[0];
  demoListeners.get(name)?.forEach((cb) => {
    try {
      cb(payload);
    } catch {
      /* listener errors must not break the emitter */
    }
  });
}

/** Subscribe to a shell event. Resolves to an unsubscribe function. */
export async function listenShell<E extends ShellEvent>(name: E, cb: Listener<E>): Promise<Unlisten> {
  if (isTauri()) {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<ShellEventPayloads[E]>(name, (ev) => cb(ev.payload));
  }
  let set = demoListeners.get(name);
  if (!set) {
    set = new Set();
    demoListeners.set(name, set);
  }
  const wrapped = (payload: unknown) => cb(payload as ShellEventPayloads[E]);
  set.add(wrapped);
  return () => {
    set.delete(wrapped);
  };
}

/** Subscribe to `tor-status`. Pair it with `torStatus()` for the current state (see the Tor store). */
export function onTorStatus(cb: (status: TorStatus) => void): Promise<Unlisten> {
  return listenShell('tor-status', cb);
}

/** Subscribe to `cbf-status` (compact-filter sync). Pair it with `btc_cbf_status` for the current state. */
export function onCbfStatus(cb: (status: CbfStatus) => void): Promise<Unlisten> {
  return listenShell('cbf-status', cb);
}

/** Subscribe to `hw-prompt` (confirm / PIN / passphrase on the device, Trezor One PIN matrix). */
export function onHwPrompt(cb: (p: HwPrompt) => void): Promise<Unlisten> {
  return listenShell('hw-prompt', cb);
}
