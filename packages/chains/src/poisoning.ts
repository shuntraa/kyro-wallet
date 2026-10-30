// SPDX-License-Identifier: GPL-3.0-or-later
//
// Address-poisoning detection (SECURITY.md). An attacker sends a dust or zero-value transfer
// from an address forged to share the first and last characters of one the user really pays,
// hoping the user copies it from the history. Before review, the recipient is compared with
// every TRUSTED address of the chain (address book, the user's own addresses, past real
// counterparties): not identical but the same first 4 and last 4 characters after the format's
// prefix → look-alike, blocking until the user confirms explicitly.
//
// Addresses that only ever appeared as the sender of an incoming dust / zero-value transfer are
// NOT trusted (they are exactly what an attacker plants): comparing against them would flag the
// real address. They only trigger a gentle note when the recipient is one of them.

import type { Family } from './registry';

export type KnownSource = 'contact' | 'own' | 'history';

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
 * The format prefix, which carries no entropy (every address of the kind has it), and whether the
 * format is case-insensitive (hex, bech32).
 * - Bitcoin / Litecoin bech32: hrp + `1` + witness-version char (`bc1q`, `tb1p`, `ltc1q`, `tltc1q`);
 *   legacy base58: the version char (`1`, `3`, `m`, `n`, `2`, `L`, `M`).
 * - Dogecoin (base58): the version char (`D`, `A`, `9`, `n`, `m`, `2`).
 * - EVM: `0x`, hex compared lowercase.
 * - Solana (base58): none.
 * - TRON: `T`. XRP: `r`.
 * - Cardano: hrp + `1` + header char (`addr1q`, `addr_test1v`, …), bech32 lowercase.
 */
export function addressParts(address: string, family: Family): AddressParts & { caseInsensitive: boolean } {
  const a = address.trim();
  const bech = /^([a-z_]+)1([02-9ac-hj-np-z])/i.exec(a);
  switch (family) {
    case 'evm':
      return a.toLowerCase().startsWith('0x') ? { prefix: '0x', body: a.slice(2).toLowerCase(), caseInsensitive: true } : { prefix: '', body: a.toLowerCase(), caseInsensitive: true };
    case 'btc':
    case 'ltc':
    case 'ada':
      if (bech) {
        const prefix = `${bech[1]}1${bech[2]}`.toLowerCase();
        return { prefix, body: a.slice(prefix.length).toLowerCase(), caseInsensitive: true };
      }
      return { prefix: a.slice(0, 1), body: a.slice(1), caseInsensitive: false };
    case 'doge':
      return { prefix: a.slice(0, 1), body: a.slice(1), caseInsensitive: false };
    case 'tron':
      return a.startsWith('T') ? { prefix: 'T', body: a.slice(1), caseInsensitive: false } : { prefix: '', body: a, caseInsensitive: false };
    case 'xrp':
      return a.startsWith('r') ? { prefix: 'r', body: a.slice(1), caseInsensitive: false } : { prefix: '', body: a, caseInsensitive: false };
    case 'sol':
      return { prefix: '', body: a, caseInsensitive: false };
  }
}

/** Same address once normalized (case-insensitive formats compared lowercase). */
export function sameAddress(a: string, b: string, family: Family): boolean {
  const x = addressParts(a, family);
  const y = addressParts(b, family);
  return x.prefix.toLowerCase() === y.prefix.toLowerCase() && x.body === y.body;
}

/** Not identical, but same prefix and same first 4 and last 4 characters of the body. */
export function isLookalike(a: string, b: string, family: Family): boolean {
  const x = addressParts(a, family);
  const y = addressParts(b, family);
  if (x.body.length < HEAD + TAIL + 1 || y.body.length < HEAD + TAIL + 1) return false;
  if (x.prefix.toLowerCase() !== y.prefix.toLowerCase()) return false;
  if (x.body === y.body) return false;
  return x.body.slice(0, HEAD) === y.body.slice(0, HEAD) && x.body.slice(-TAIL) === y.body.slice(-TAIL);
}

export interface Lookalike {
  /** The trusted address the recipient imitates. */
  known: KnownAddress;
}

/**
 * The first trusted address the recipient looks like (contacts first, then own, then history),
 * or null. An exact match with any trusted address means no warning.
 */
export function findLookalike(recipient: string, known: KnownAddress[], family: Family): Lookalike | null {
  const to = recipient.trim();
  if (!to) return null;
  if (known.some((k) => sameAddress(k.address, to, family))) return null;
  const order: KnownSource[] = ['contact', 'own', 'history'];
  for (const src of order) {
    const k = known.find((x) => x.source === src && isLookalike(x.address, to, family));
    if (k) return { known: k };
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
  direction: 'in' | 'out' | 'self';
  /** Incoming dust or zero-value transfer (the poisoning vector). */
  dust: boolean;
}

/**
 * Splits the history's counterparties: trusted ones (any outgoing payment, or a real incoming
 * one) and suspects (seen ONLY through incoming dust / zero-value transfers).
 */
export function classifyHistoryAddresses(events: HistoryAddressEvent[], family: Family): { trusted: string[]; dustOnly: string[] } {
  const byKey = new Map<string, { address: string; real: boolean }>();
  for (const e of events) {
    const { prefix, body } = addressParts(e.counterparty, family);
    const key = `${prefix.toLowerCase()}|${body}`;
    const cur = byKey.get(key) ?? { address: e.counterparty, real: false };
    if (!(e.direction === 'in' && e.dust)) cur.real = true;
    byKey.set(key, cur);
  }
  const trusted: string[] = [];
  const dustOnly: string[] = [];
  for (const v of byKey.values()) (v.real ? trusted : dustOnly).push(v.address);
  return { trusted, dustOnly };
}

/** The recipient only ever appeared in the history as the sender of incoming dust. */
export function isDustOnlyAddress(recipient: string, dustOnly: string[], family: Family): boolean {
  return dustOnly.some((d) => sameAddress(d, recipient, family));
}
