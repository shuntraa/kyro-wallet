// SPDX-License-Identifier: GPL-3.0-or-later
//
// Hardware wallets, UI side (docs/IPC.md §2.3).
// - one prompt store, fed by the `hw-prompt` event (confirm / PIN / passphrase on the device,
//   Trezor One blind PIN matrix), started once in main.tsx;
// - device picking for a stored account (`hw_list`, same brand; Rust then checks the keys);
// - precise French messages for every HW_* error, using the error `data`.

import { useSyncExternalStore } from 'react';
import { call, errorData, ipcErrorIn, onHwPrompt, toIpcError, type HwDeviceInfo, type HwDeviceKind, type HwPrompt, type IpcError, type Unlisten } from '@kyro/shared';

// ---------------------------------------------------------------- prompts

export interface HwPromptSnapshot {
  /** Last prompt per device id, cleared when the operation ends. */
  byDevice: Record<string, HwPrompt['kind']>;
}

export interface HwPromptStore {
  getSnapshot(): HwPromptSnapshot;
  subscribe(l: () => void): () => void;
  start(): Promise<void>;
  stop(): void;
  /** The operation on `id` ended (success, error, cancel): forget its prompt. */
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
      started ??= listen((p) => set({ byDevice: { ...snap.byDevice, [p.id]: p.kind } })).then((u) => {
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
      set({ byDevice: rest });
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

// ---------------------------------------------------------------- devices

export const BRAND: Record<HwDeviceKind, string> = { ledger: 'Ledger', trezor: 'Trezor' };

/** A plugged-in device of the account's brand (Rust compares the keys before anything). */
export async function pickDevice(kind: HwDeviceKind): Promise<HwDeviceInfo> {
  const list = await call('hw_list');
  const d = list.find((x) => x.kind === kind);
  if (!d) throw new Error(`Aucun ${BRAND[kind]} détecté : branche-le, déverrouille-le, puis réessaie.`);
  return d;
}

// ---------------------------------------------------------------- errors

export interface HwErrorView {
  /** Short title. */
  title: string;
  /** What happened and what to do, in plain French. */
  detail: string;
  /** Nothing was sent / signed (the user can retry safely). */
  safe: boolean;
}

/** Precise French message for a hardware-wallet error (any error: falls back to its message). */
export function hwErrorView(e: unknown): HwErrorView {
  const err: IpcError = ipcErrorIn(e) ?? toIpcError(e);
  switch (err.code) {
    case 'HW_NOT_FOUND':
      return { title: 'Appareil introuvable', detail: 'Branche-le, déverrouille-le, puis relance la détection.', safe: true };
    case 'HW_LOCKED':
      return { title: 'Appareil verrouillé', detail: 'Déverrouille-le avec ton code PIN (sur l’appareil, ou la grille pour une Trezor One), puis réessaie.', safe: true };
    case 'HW_WRONG_APP': {
      const d = errorData(e, 'HW_WRONG_APP');
      return {
        title: 'Mauvaise application ouverte',
        detail: d ? `Ouvre l’app « ${d.expected} » sur ton Ledger (ouverte : « ${d.open} »), puis réessaie.` : err.message,
        safe: true,
      };
    }
    case 'HW_REJECTED':
      return { title: 'Refusé sur l’appareil', detail: 'Tu as refusé sur l’écran de l’appareil : rien n’a été signé ni envoyé.', safe: true };
    case 'HW_DISCONNECTED':
      return { title: 'Appareil débranché', detail: 'L’appareil a été débranché ou ne répond plus pendant l’opération : elle est abandonnée, rien n’a été signé ni envoyé. Rebranche-le et recommence.', safe: true };
    case 'HW_TIMEOUT':
      return { title: 'Pas de réponse de l’appareil', detail: 'Délai dépassé sans confirmation sur l’appareil : opération abandonnée, rien n’a été envoyé.', safe: true };
    case 'HW_UNSUPPORTED': {
      const d = errorData(e, 'HW_UNSUPPORTED');
      const reason = err.message.replace(/^Non pris en charge\s*:\s*/, '');
      return {
        title: d?.min ? 'Firmware ou application trop ancien' : 'Non pris en charge',
        detail: d?.min ? `${reason}. Mets à jour ton appareil (version ${d.min} minimum), puis réessaie.` : `${reason}.`,
        safe: true,
      };
    }
    case 'HW_BUSY':
      return { title: 'Appareil occupé', detail: 'Une autre opération est en cours, ou une autre application (Ledger Live, Trezor Suite) utilise l’appareil : ferme-la puis réessaie.', safe: true };
    case 'HW_BAD_RESPONSE':
      return { title: 'Réponse de l’appareil refusée', detail: `Kyro a vérifié la réponse de l’appareil et la refuse : rien n’a été envoyé. ${err.message.replace(/^Réponse de l’appareil refusée par Kyro\s*:\s*/, '').replace(/^Réponse de l'appareil refusée par Kyro\s*:\s*/, '')}`, safe: true };
    case 'HW_ADDRESS_MISMATCH':
      return { title: 'Adresses différentes', detail: 'L’appareil affiche une autre adresse que celle calculée par Kyro. Ne reçois pas de fonds sur cette adresse.', safe: false };
    case 'HW_WRONG_DEVICE':
      return { title: 'Pas le bon appareil', detail: 'Les clés de cet appareil ne sont pas celles du compte (autre appareil, autre passphrase, ou compte modifié). Branche l’appareil de ce compte.', safe: true };
    case 'USER_REJECTED':
      return { title: 'Annulé', detail: 'Opération annulée : rien n’a été signé ni envoyé.', safe: true };
    case 'LOCKED':
      return { title: 'Coffre verrouillé', detail: 'Déverrouille Kyro pour utiliser ton hardware wallet.', safe: true };
    default:
      return { title: 'Erreur', detail: err.message, safe: true };
  }
}

/** True for HW_ADDRESS_MISMATCH: a blocking stop, never "just an error". */
export function isAddressMismatch(e: unknown): boolean {
  return ipcErrorIn(e)?.code === 'HW_ADDRESS_MISMATCH';
}

// ---------------------------------------------------------------- Trezor One PIN matrix

/**
 * Trezor One blind PIN: the device shows a scrambled 3×3 layout, the computer shows 9 blank
 * cells, and only POSITIONS travel. Trezor's protocol numbers positions like a numeric KEYPAD
 * (trezorlib, firmware): 7 8 9 on the top row, 4 5 6 in the middle, 1 2 3 at the bottom.
 * Rust (`hw_pin_matrix` → `PinMatrixAck.pin`) forwards the positions verbatim, so this is the
 * convention the UI must send. Row 0 = top row of the grid as drawn.
 */
export const PIN_MATRIX_KEYPAD: readonly (readonly string[])[] = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
];

export function pinPosition(row: number, col: number): string {
  const p = PIN_MATRIX_KEYPAD[row]?.[col];
  if (!p) throw new Error('Case de la grille invalide');
  return p;
}
