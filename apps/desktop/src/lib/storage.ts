// SPDX-License-Identifier: GPL-3.0-or-later
//
// Per-device conveniences in localStorage (always try/catch: private mode,
// disabled storage, quota). PUBLIC DATA ONLY: never a secret, never the phrase.

import type { Network } from '@kyro/shared';

const P = 'kyro.';

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(P + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(P + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep in memory only */
  }
}

// ---------------------------------------------------------------- favourites

export function getFavorites(): string[] {
  const v = readJson<unknown>('favorites', []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
export function setFavorites(ids: string[]): void {
  writeJson('favorites', [...new Set(ids)]);
}

// ---------------------------------------------------------------- address book

/** XRP contacts: the classic address only (the destination tag is per payment). TON: no comment either. */
export type ContactFamily = 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'tron' | 'xrp' | 'ada' | 'ton';
export interface Contact {
  id: string;
  name: string;
  address: string;
  family: ContactFamily;
  /** Number of sends from Kyro to this contact. */
  sends: number;
}

export function getContacts(): Contact[] {
  const v = readJson<unknown>('contacts', []);
  return Array.isArray(v) ? (v as Contact[]).filter((c) => c && typeof c.address === 'string' && typeof c.name === 'string') : [];
}
export function saveContacts(list: Contact[]): void {
  writeJson('contacts', list);
}
export function findContact(address: string, family: ContactFamily): Contact | undefined {
  const a = family === 'evm' ? address.trim().toLowerCase() : address.trim();
  return getContacts().find((c) => c.family === family && (family === 'evm' ? c.address.toLowerCase() : c.address) === a);
}
export function bumpContactSends(id: string): void {
  saveContacts(getContacts().map((c) => (c.id === id ? { ...c, sends: (c.sends ?? 0) + 1 } : c)));
}

// ---------------------------------------------------------------- local tx records

/** Transactions sent from this device (EVM native sends cannot be listed without an indexer). */
export interface LocalTx {
  id: string;
  network: Network;
  chainKey: string;
  assetId: string;
  kind: 'transfer' | 'swap' | 'approval';
  direction: 'out' | 'self';
  amount: string;
  fee?: string;
  counterparty?: string;
  label?: string;
  time: number;
  status: 'pending' | 'confirmed' | 'failed';
}

const DECIMAL = /^\d{1,78}$/;

/**
 * Shape check of a record read back from localStorage (an old version, a manual edit or another
 * script may have left anything there). Its recipient counts as « already paid from this Kyro »
 * for the address-poisoning check, so a malformed entry is dropped rather than trusted.
 */
export function isLocalTx(x: unknown, network: Network): x is LocalTx {
  if (!x || typeof x !== 'object') return false;
  const t = x as Record<string, unknown>;
  const str = (k: string, max = 200) => typeof t[k] === 'string' && (t[k] as string).length > 0 && (t[k] as string).length <= max;
  const optStr = (k: string, max = 200) => t[k] === undefined || (typeof t[k] === 'string' && (t[k] as string).length <= max);
  return (
    str('id') &&
    t.network === network &&
    str('chainKey', 64) &&
    str('assetId') &&
    (t.kind === 'transfer' || t.kind === 'swap' || t.kind === 'approval') &&
    (t.direction === 'out' || t.direction === 'self') &&
    typeof t.amount === 'string' &&
    DECIMAL.test(t.amount) &&
    (t.fee === undefined || (typeof t.fee === 'string' && DECIMAL.test(t.fee))) &&
    optStr('counterparty', 130) &&
    optStr('label') &&
    typeof t.time === 'number' &&
    Number.isFinite(t.time) &&
    (t.status === 'pending' || t.status === 'confirmed' || t.status === 'failed')
  );
}

export function getLocalTxs(network: Network): LocalTx[] {
  const v = readJson<unknown>(`txs.${network}`, []);
  return Array.isArray(v) ? v.filter((x): x is LocalTx => isLocalTx(x, network)) : [];
}
export function addLocalTx(tx: LocalTx): void {
  const list = getLocalTxs(tx.network).filter((t) => t.id !== tx.id);
  writeJson(`txs.${tx.network}`, [tx, ...list].slice(0, 300));
}
export function updateLocalTx(network: Network, id: string, patch: Partial<LocalTx>): void {
  writeJson(`txs.${network}`, getLocalTxs(network).map((t) => (t.id === id ? { ...t, ...patch } : t)));
}

// ---------------------------------------------------------------- last known prices

/** Last plausible price seen on this device, per coin and currency (fiat-entry check in Envoyer). */
export function getLastPrice(coinId: string, currency: string): { price: number; at: number } | null {
  const v = readJson<unknown>(`price.${currency}.${coinId}`, null);
  if (!v || typeof v !== 'object') return null;
  const { price, at } = v as { price?: unknown; at?: unknown };
  return typeof price === 'number' && Number.isFinite(price) && price > 0 && typeof at === 'number' && Number.isFinite(at) ? { price, at } : null;
}
export function setLastPrice(coinId: string, currency: string, price: number): void {
  if (Number.isFinite(price) && price > 0) writeJson(`price.${currency}.${coinId}`, { price, at: Date.now() });
}

// ---------------------------------------------------------------- approvals

export interface ApprovalRecord {
  network: Network;
  chainId: number;
  chainKey: string;
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  spender: string;
  spenderLabel: string;
  amount: string;
  unlimited: boolean;
  time: number;
  txHash: string;
}

export function getApprovals(network: Network): ApprovalRecord[] {
  const v = readJson<unknown>(`approvals.${network}`, []);
  return Array.isArray(v) ? (v as ApprovalRecord[]) : [];
}
export function addApproval(a: ApprovalRecord): void {
  const key = (x: ApprovalRecord) => `${x.chainId}:${x.token.toLowerCase()}:${x.spender.toLowerCase()}`;
  const list = getApprovals(a.network).filter((x) => key(x) !== key(a));
  writeJson(`approvals.${a.network}`, [a, ...list]);
}
export function removeApproval(network: Network, chainId: number, token: string, spender: string): void {
  writeJson(
    `approvals.${network}`,
    getApprovals(network).filter((x) => !(x.chainId === chainId && x.token.toLowerCase() === token.toLowerCase() && x.spender.toLowerCase() === spender.toLowerCase())),
  );
}

// ---------------------------------------------------------------- backup flag

export type BackupState = 'confirmed' | 'imported' | 'unknown';
export function getBackupState(): BackupState {
  const v = readJson<string>('backup', 'unknown');
  return v === 'confirmed' || v === 'imported' ? v : 'unknown';
}
export function setBackupState(s: BackupState): void {
  writeJson('backup', s);
}
