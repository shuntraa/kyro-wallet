// SPDX-License-Identifier: GPL-3.0-or-later
// Private notes on transactions: kept in this device's storage (per wallet, per network), shown in
// History, written to the CSV export and carried by the encrypted backup. Never sent anywhere.

import type { BackupNote, Network } from '@kyro/shared';
import { readJson, scoped, writeJson } from './storage';

/** Same limit as Rust (`backup.rs` MAX_NOTE). */
export const MAX_NOTE = 200;
const MAX_NOTES = 5_000;
/** What Rust refuses in a note: control, format and direction characters. */
const UNSAFE = /[\p{Cc}\p{Cf}]/gu;
const CHAIN = /^[a-z0-9-]{1,64}$/;
const ID = /^[\x21-\x7e]{1,200}$/;

const key = (network: Network) => scoped(`txnotes.${network}`);
const noteKey = (chainKey: string, id: string) => `${chainKey}:${id}`;

/** The text as stored: no control or invisible character, trimmed, at most MAX_NOTE characters. */
export function cleanNote(text: string): string {
  return [...text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()].slice(0, MAX_NOTE).join('');
}

export function getNotes(network: Network): Record<string, string> {
  const v = readJson<unknown>(key(network), {});
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, t] of Object.entries(v as Record<string, unknown>)) if (typeof t === 'string' && t) out[k] = t;
  return out;
}

export function getNote(network: Network, chainKey: string, id: string): string | undefined {
  return getNotes(network)[noteKey(chainKey, id)];
}

/** Empty text removes the note. */
export function setNote(network: Network, chainKey: string, id: string, text: string): void {
  const notes = getNotes(network);
  const k = noteKey(chainKey, id);
  const clean = cleanNote(text);
  if (clean) notes[k] = clean;
  else delete notes[k];
  writeJson(key(network), notes);
}

/** Every note of both networks, in the shape Rust checks. An entry Rust would refuse stays out. */
export function collectNotes(): BackupNote[] {
  const out: BackupNote[] = [];
  for (const network of ['mainnet', 'testnet'] as const) {
    for (const [k, text] of Object.entries(getNotes(network))) {
      const i = k.indexOf(':');
      const chain = k.slice(0, i);
      const id = k.slice(i + 1);
      const clean = cleanNote(text);
      if (i > 0 && CHAIN.test(chain) && ID.test(id) && clean) out.push({ network, chain, id, text: clean });
    }
  }
  return out.slice(0, MAX_NOTES);
}

/** Notes of the backup this device lacks. A note already here is never replaced. */
export function planNotes(incoming: BackupNote[] | undefined): BackupNote[] {
  const have = { mainnet: getNotes('mainnet'), testnet: getNotes('testnet') };
  const seen = new Set<string>();
  return (incoming ?? []).filter((n) => {
    const k = `${n.network}|${noteKey(n.chain, n.id)}`;
    if (seen.has(k) || have[n.network]?.[noteKey(n.chain, n.id)] !== undefined) return false;
    seen.add(k);
    return true;
  });
}

export function applyNotes(add: BackupNote[]): void {
  for (const network of ['mainnet', 'testnet'] as const) {
    const mine = add.filter((n) => n.network === network);
    if (mine.length === 0) continue;
    const notes = getNotes(network);
    for (const n of mine) notes[noteKey(n.chain, n.id)] = cleanNote(n.text);
    writeJson(key(network), notes);
  }
}
