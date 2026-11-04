// SPDX-License-Identifier: GPL-3.0-or-later
// Address-poisoning detection (SECURITY.md): a recipient that shares the first and last 4 chars of a
// reference address without being it blocks until the user confirms. Server history is never trusted:
// zero-value / dust / unsigned transfers never make an address a reference.

import type { Family } from './registry';
import { sameTonAccount } from '@kyro/shared';

/** `sent`: recipient of a send signed by this device. `history`: other server-history counterparty (proves nothing). */
export type KnownSource = 'contact' | 'own' | 'sent' | 'history';

export interface KnownAddress {
  address: string;
  source: KnownSource;
  /** Contact name, "ton adresse", … */
  label?: string;
}

/** Split of an address for comparison: format prefix, then the body that is compared. */
export interface AddressParts {
  prefix: string;
  body: string;
}

const HEAD = 4;
const TAIL = 4;

/**
 * The format prefix (carries no entropy) and whether the format is case-insensitive (hex, bech32).
 * TON `EQ…` / `UQ…` forms of one account are the same address (`sameAddress`).
 */
export function addressParts(address: string, family: Family): AddressParts & { caseInsensitive: boolean } {
  const a = address.trim();
  const bech = /^([a-z_]+)1([02-9ac-hj-np-z])/i.exec(a);
  switch (family) {
    case 'evm':
    case 'sui':
    case 'apt':
      return a.toLowerCase().startsWith('0x') ? { prefix: '0x', body: a.slice(2).toLowerCase(), caseInsensitive: true } : { prefix: '', body: a.toLowerCase(), caseInsensitive: true };
    case 'btc':
    case 'ltc':
    case 'ada':
    case 'cosmos':
      if (bech) {
        const prefix = `${bech[1]}1${bech[2]}`.toLowerCase();
        return { prefix, body: a.slice(prefix.length).toLowerCase(), caseInsensitive: true };
      }
      return { prefix: a.slice(0, 1), body: a.slice(1), caseInsensitive: false };
    case 'doge':
    case 'dash':
    case 'xmr':
      return { prefix: a.slice(0, 1), body: a.slice(1), caseInsensitive: false };
    case 'bch': {
      const lower = a.toLowerCase();
      const bare = lower.includes(':') ? lower.slice(lower.indexOf(':') + 1) : lower;
      return { prefix: bare.slice(0, 1), body: bare.slice(1), caseInsensitive: true };
    }
    case 'zec':
      if (/^tex(test)?1/i.test(a)) {
        const prefix = a.toLowerCase().startsWith('textest1') ? 'textest1' : 'tex1';
        return { prefix, body: a.slice(prefix.length).toLowerCase(), caseInsensitive: true };
      }
      return { prefix: a.slice(0, 2), body: a.slice(2), caseInsensitive: false };
    case 'tron':
      return a.startsWith('T') ? { prefix: 'T', body: a.slice(1), caseInsensitive: false } : { prefix: '', body: a, caseInsensitive: false };
    case 'xrp':
      return a.startsWith('r') ? { prefix: 'r', body: a.slice(1), caseInsensitive: false } : { prefix: '', body: a, caseInsensitive: false };
    case 'xlm':
      return a.startsWith('G') ? { prefix: 'G', body: a.slice(1), caseInsensitive: false } : { prefix: '', body: a, caseInsensitive: false };
    case 'sol':
    case 'algo':
      return { prefix: '', body: a, caseInsensitive: false };
    case 'near':
      return { prefix: '', body: a.toLowerCase(), caseInsensitive: true };
    case 'hbar':
      if (a.toLowerCase().startsWith('0x')) return { prefix: '0x', body: a.slice(2).toLowerCase(), caseInsensitive: true };
      if (a.startsWith('0.0.')) return { prefix: '0.0.', body: (a.slice(4).split('-')[0] ?? ''), caseInsensitive: true };
      return { prefix: '', body: a.toLowerCase(), caseInsensitive: true };
    case 'kas': {
      // `kaspa:` / `kaspatest:` + the version character (`q` P2PK, `p` P2SH), bech32 lowercase.
      const k = /^(kaspa(?:test)?:)([a-z0-9])/i.exec(a);
      if (k?.[1] && k[2]) {
        const prefix = `${k[1]}${k[2]}`.toLowerCase();
        return { prefix, body: a.slice(prefix.length).toLowerCase(), caseInsensitive: true };
      }
      return { prefix: '', body: a.toLowerCase(), caseInsensitive: true };
    }
    case 'dot':
      // SS58: the first character only depends on the network prefix (`1` Polkadot, `5` generic).
      return { prefix: a.slice(0, 1), body: a.slice(1), caseInsensitive: false };
    case 'ton':
      return { prefix: a.slice(0, 2), body: a.slice(2), caseInsensitive: false };
  }
}

/** Same address once normalized (case-insensitive formats compared lowercase). */
export function sameAddress(a: string, b: string, family: Family): boolean {
  if (family === 'ton' && sameTonAccount(a, b)) return true;
  const x = addressParts(a, family);
  const y = addressParts(b, family);
  // Base58 prefixes are case-sensitive (Dash `X…` ≠ `x…`); case-insensitive formats are already lowercased.
  return x.prefix === y.prefix && x.body === y.body;
}

/** Not identical, but same prefix and same first 4 and last 4 characters of the body. */
export function isLookalike(a: string, b: string, family: Family): boolean {
  if (family === 'ton' && sameTonAccount(a, b)) return false;
  const x = addressParts(a, family);
  const y = addressParts(b, family);
  if (x.body.length < HEAD + TAIL + 1 || y.body.length < HEAD + TAIL + 1) return false;
  if (x.prefix.toLowerCase() !== y.prefix.toLowerCase()) return false;
  if (x.body === y.body) return false;
  return x.body.slice(0, HEAD) === y.body.slice(0, HEAD) && x.body.slice(-TAIL) === y.body.slice(-TAIL);
}

export interface Lookalike {
  /** The reference address the recipient imitates. */
  known: KnownAddress;
  /** Set when the recipient is itself a reference while looking like another one. */
  recipientKnown?: KnownAddress;
}

const ORDER: KnownSource[] = ['contact', 'own', 'sent', 'history'];

/**
 * The first reference the recipient looks like, or null. An exact match does NOT end the check:
 * otherwise an attacker who gets his look-alike into the list would silence the alert on it.
 */
export function findLookalike(recipient: string, known: KnownAddress[], family: Family): Lookalike | null {
  const to = recipient.trim();
  if (!to) return null;
  const exact = ORDER.map((src) => known.find((k) => k.source === src && sameAddress(k.address, to, family))).find((k) => k !== undefined);
  for (const src of ORDER) {
    const k = known.find((x) => x.source === src && !sameAddress(x.address, to, family) && isLookalike(x.address, to, family));
    if (k) return exact ? { known: k, recipientKnown: exact } : { known: k };
  }
  return null;
}

/** For display: prefix, head, the differing middle (to highlight), tail. */
export function lookalikeSegments(address: string, family: Family): { prefix: string; head: string; middle: string; tail: string } {
  const a = address.trim();
  const { prefix } = addressParts(a, family);
  const rest = a.slice(prefix.length);
  return { prefix: a.slice(0, prefix.length), head: rest.slice(0, HEAD), middle: rest.slice(HEAD, rest.length - TAIL), tail: rest.slice(-TAIL) };
}

export interface HistoryAddressEvent {
  counterparty: string;
  /** Zero-value, dust or not-signed-by-us transfer: what a poisoning attacker can plant for free. */
  suspect: boolean;
}

/**
 * `trusted`: recipients of sends signed by this device. `references`: other non-suspect counterparties
 * (compared, but an exact match proves nothing). `suspects`: seen only via suspect transfers, never a reference.
 */
export function classifyHistoryAddresses(events: HistoryAddressEvent[], signedHere: string[], family: Family): { trusted: string[]; references: string[]; suspects: string[] } {
  const keyOf = (a: string) => {
    const { prefix, body } = addressParts(a, family);
    return `${prefix.toLowerCase()}|${body}`;
  };
  const trusted = new Map<string, string>();
  for (const a of signedHere) if (a.trim()) trusted.set(keyOf(a), a.trim());
  const byKey = new Map<string, { address: string; real: boolean }>();
  for (const e of events) {
    if (!e.counterparty.trim()) continue;
    const key = keyOf(e.counterparty);
    const cur = byKey.get(key) ?? { address: e.counterparty, real: false };
    if (!e.suspect) cur.real = true;
    byKey.set(key, cur);
  }
  const references: string[] = [];
  const suspects: string[] = [];
  for (const [key, v] of byKey) {
    if (trusted.has(key)) continue;
    (v.real ? references : suspects).push(v.address);
  }
  return { trusted: [...trusted.values()], references, suspects };
}

/** The recipient only ever appeared in the history through suspect (zero / dust / unsigned) transfers. */
export function isSuspectAddress(recipient: string, suspects: string[], family: Family): boolean {
  return suspects.some((d) => sameAddress(d, recipient, family));
}

/** Per-chain dust thresholds, base units: 10 × the network's dust limit. */
const DUST_UNITS: Partial<Record<Family, bigint>> = { btc: 5_460n, ltc: 29_400n, doge: 10_000_000n, bch: 5_460n, dash: 5_460n, zec: 540n };

/** Dust threshold of a UTXO chain, base units; undefined elsewhere. */
export const dustUnits = (family: Family): bigint | undefined => DUST_UNITS[family];

/** Fiat value under which any transfer is dust (planting a look-alike costs less than that). */
export const DUST_FIAT = 1;

/** Zero, under 1 (fiat) when priced, or under 10 × the UTXO dust limit: a lure, not a payment. */
export function isDustAmount(family: Family, amount: bigint, fiat: number | null): boolean {
  if (amount <= 0n) return true;
  if (fiat !== null && Number.isFinite(fiat) && fiat < DUST_FIAT) return true;
  const units = DUST_UNITS[family];
  return units !== undefined && amount <= units;
}

/** EVM: a transfer in worth under 1 (fiat), not already marked. Poisoners also send real tokens, in tiny amounts. */
export function isTinyLure(e: { direction: string; kind: string; amount: bigint; suspect?: unknown }, family: Family | undefined, fiat: number | null): boolean {
  return family === 'evm' && e.kind === 'transfer' && e.direction === 'in' && !e.suspect && isDustAmount(family, e.amount, fiat);
}
