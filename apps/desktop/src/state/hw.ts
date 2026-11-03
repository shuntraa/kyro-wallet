// SPDX-License-Identifier: GPL-3.0-or-later
// Hardware wallets, UI side (docs/IPC.md §2.3). - one prompt store, fed by the `hw-prompt` event
// (confirm / PIN / passphrase on the device, Trezor One blind PIN matrix), started once in
// main.tsx; - device picking for a stored account (`hw_list`, same brand; Rust then checks the
// keys); - precise messages (current language, ../i18n) for every HW_* error, using the error
// `data`.

import { useSyncExternalStore } from 'react';
import { call, errorData, ipcErrorIn, onHwPrompt, toIpcError, type HwDeviceInfo, type HwDeviceKind, type HwPrompt, type IpcError, type Unlisten } from '@kyro/shared';
import { t } from '../i18n';

export interface HwPromptSnapshot {
  byDevice: Record<string, HwPrompt['kind']>;
  /** `open-app` prompts: the app being opened, per device. */
  apps?: Record<string, string>;
}

export interface HwPromptStore {
  getSnapshot(): HwPromptSnapshot;
  subscribe(l: () => void): () => void;
  start(): Promise<void>;
  stop(): void;
  clear(id: string): void;
}

export function createHwPromptStore(listen: (cb: (p: HwPrompt) => void) => Promise<Unlisten>): HwPromptStore {
  let snap: HwPromptSnapshot = { byDevice: {} };
  const listeners = new Set<() => void>();
  let un: Unlisten | null = null;
  let started: Promise<void> | null = null;
  const set = (next: HwPromptSnapshot) => {
    snap = next;
    listeners.forEach((l) => l());
  };
  return {
    getSnapshot: () => snap,
    subscribe(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    start() {
      started ??= listen((p) =>
        set({ byDevice: { ...snap.byDevice, [p.id]: p.kind }, ...(p.app || snap.apps ? { apps: { ...snap.apps, ...(p.app ? { [p.id]: p.app } : {}) } } : {}) }),
      ).then((u) => {
        un = u;
      });
      return started;
    },
    stop() {
      un?.();
      un = null;
      started = null;
    },
    clear(id) {
      if (!(id in snap.byDevice)) return;
      const { [id]: _gone, ...rest } = snap.byDevice;
      const { [id]: _app, ...apps } = snap.apps ?? {};
      set(snap.apps ? { byDevice: rest, apps } : { byDevice: rest });
    },
  };
}

export const hwPromptStore = createHwPromptStore(onHwPrompt);

export function useHwPrompts(): HwPromptSnapshot {
  return useSyncExternalStore(hwPromptStore.subscribe, hwPromptStore.getSnapshot);
}

/** Runs one device operation and always clears its prompt afterwards. */
export async function withDevice<T>(id: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } finally {
    hwPromptStore.clear(id);
  }
}

export const BRAND: Record<HwDeviceKind, string> = { ledger: 'Ledger', trezor: 'Trezor' };

/** A plugged-in device of the account's brand (Rust compares the keys before anything). */
export async function pickDevice(kind: HwDeviceKind): Promise<HwDeviceInfo> {
  const list = await call('hw_list');
  const d = list.find((x) => x.kind === kind);
  if (!d) throw new Error(t('hw.noneDetected', { brand: BRAND[kind] }));
  return d;
}

export interface HwErrorView {
  title: string;
  detail: string;
  safe: boolean;
}

/** Precise message for a hardware-wallet error (any error: falls back to its message). */
export function hwErrorView(e: unknown): HwErrorView {
  const err: IpcError = ipcErrorIn(e) ?? toIpcError(e);
  switch (err.code) {
    case 'HW_NOT_FOUND':
      return { title: t('hw.err.notFoundTitle'), detail: t('hw.err.notFoundDetail'), safe: true };
    case 'HW_LOCKED':
      return { title: t('hw.err.lockedTitle'), detail: t('hw.err.lockedDetail'), safe: true };
    case 'HW_WRONG_APP': {
      const d = errorData(e, 'HW_WRONG_APP');
      return {
        title: t('hw.err.wrongAppTitle'),
        detail: d ? t('hw.err.wrongAppDetail', { expected: d.expected, open: d.open }) : err.message,
        safe: true,
      };
    }
    case 'HW_APP_MISSING': {
      const d = errorData(e, 'HW_APP_MISSING');
      return { title: t('hw.err.appMissingTitle'), detail: d ? t('hw.err.appMissingDetail', { app: d.app }) : err.message, safe: true };
    }
    case 'HW_REJECTED':
      return { title: t('hw.err.rejectedTitle'), detail: t('hw.err.rejectedDetail'), safe: true };
    case 'HW_DISCONNECTED':
      return { title: t('hw.err.disconnectedTitle'), detail: t('hw.err.disconnectedDetail'), safe: true };
    case 'HW_TIMEOUT':
      return { title: t('hw.err.timeoutTitle'), detail: t('hw.err.timeoutDetail'), safe: true };
    case 'HW_UNSUPPORTED': {
      const d = errorData(e, 'HW_UNSUPPORTED');
      const reason = err.message.replace(/^(Non pris en charge|Not supported|Unsupported)\s*:\s*/i, '');
      return {
        title: d?.min ? t('hw.err.tooOldTitle') : t('hw.err.unsupportedTitle'),
        detail: d?.min ? t('hw.err.tooOldDetail', { reason, min: d.min }) : `${reason}.`,
        safe: true,
      };
    }
    case 'HW_BUSY':
      return { title: t('hw.err.busyTitle'), detail: t('hw.err.busyDetail'), safe: true };
    case 'HW_BAD_RESPONSE':
      // Rust's prefix (« Réponse de l’appareil refusée par Kyro : » or its English version) is the title.
      return { title: t('hw.err.badResponseTitle'), detail: t('hw.err.badResponseDetail', { reason: err.message.replace(/^Réponse de l[’']appareil refusée par Kyro\s*:\s*/, '').replace(/^[^:]*\bby Kyro\s*:\s*/i, '') }), safe: true };
    case 'HW_ADDRESS_MISMATCH':
      return { title: t('hw.err.mismatchTitle'), detail: t('hw.err.mismatchDetail'), safe: false };
    case 'HW_PAIRING_FAILED':
      return { title: t('hw.err.pairingFailedTitle'), detail: t('hw.err.pairingFailedDetail'), safe: true };
    case 'HW_PAIRING_REQUIRED':
      return { title: t('hw.err.pairingRequiredTitle'), detail: t('hw.err.pairingRequiredDetail'), safe: true };
    case 'HW_WRONG_DEVICE':
      return { title: t('hw.err.wrongDeviceTitle'), detail: t('hw.err.wrongDeviceDetail'), safe: true };
    case 'USER_REJECTED':
      return { title: t('hw.err.cancelledTitle'), detail: t('hw.err.cancelledDetail'), safe: true };
    case 'LOCKED':
      return { title: t('hw.err.vaultLockedTitle'), detail: t('hw.err.vaultLockedDetail'), safe: true };
    default:
      return { title: t('hw.err.genericTitle'), detail: err.message, safe: true };
  }
}

/** True for HW_ADDRESS_MISMATCH: a blocking stop, never "just an error". */
export function isAddressMismatch(e: unknown): boolean {
  return ipcErrorIn(e)?.code === 'HW_ADDRESS_MISMATCH';
}

/**
 * Trezor One blind PIN: the device shows a scrambled 3×3 layout, the computer shows 9 blank cells,
 * and only POSITIONS travel.
 */
export const PIN_MATRIX_KEYPAD: readonly (readonly string[])[] = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
];

export function pinPosition(row: number, col: number): string {
  const p = PIN_MATRIX_KEYPAD[row]?.[col];
  if (!p) throw new Error(t('hw.invalidCell'));
  return p;
}

/**
 * One-step connect: what to do when reading one chain fails. A missing app, a refusal on the
 * device, an app too old or that did not start only skip that chain; anything else (unplugged,
 * locked, timeout, wrong device…) stops the run.
 */
export type ConnectOutcome = 'missing' | 'skipped' | 'old' | 'stop';
export function connectOutcome(e: unknown): ConnectOutcome {
  const err = ipcErrorIn(e) ?? toIpcError(e);
  switch (err.code) {
    case 'HW_APP_MISSING':
      return 'missing';
    case 'HW_REJECTED':
    case 'HW_WRONG_APP':
      return 'skipped';
    case 'HW_UNSUPPORTED':
      return errorData(e, 'HW_UNSUPPORTED')?.min ? 'old' : 'skipped';
    default:
      return 'stop';
  }
}
