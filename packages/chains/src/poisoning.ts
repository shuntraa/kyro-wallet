// SPDX-License-Identifier: GPL-3.0-or-later
//
// Address-poisoning detection (SECURITY.md). An attacker sends a dust or zero-value transfer
// involving an address forged to share the first and last characters of one the user really
// pays, hoping the user copies it from the history. Before review, the recipient is compared with
// every reference address of the chain (address book, the user's own addresses, recipients of
// sends signed by this device, other non-suspect counterparties of the history): not identical
// but the same first 4 and last 4 characters after the format's prefix → look-alike, blocking
// until the user confirms explicitly. Being exactly one of the references never exempts the
// recipient from the comparison with the others.
//
// What the server's history says is never « trusted »: a zero-value `transferFrom(victim, L, 0)`
// shows up as « sent by you to L », a 0-lamport Solana transfer as an outgoing payment. Suspect
// transfers (zero, dust, not signed by us) never make an address a reference; their counterparties
// only trigger a note when the recipient is one of them.

import type { Family } from './registry';

/**
 * Where a reference comes from. `sent`: a recipient of a send signed by this device (Kyro's own
 * record). `history`: another counterparty of the server's history (not proof of anything).
 */
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
 * The format prefix, which carries no entropy (every address of the kind has it), and whether the
 * format is case-insensitive (hex, bech32).
 * - Bitcoin / Litecoin bech32: hrp + `1` + witness-version char (`bc1q`, `tb1p`, `ltc1q`, `tltc1q`);
 *   legacy base58: the version char (`1`, `3`, `m`, `n`, `2`, `L`, `M`).
 * - Dogecoin, Dash (base58): the version char (`D`, `A`, `9`, `n`, `m`, `2`; `X`, `7`, `y`, `8`, `9`).
 * - Bitcoin Cash (CashAddr): `bitcoincash:` / `bchtest:` (optional) + the type char (`q`, `p`),
 *   compared lowercase.
 * - EVM: `0x`, hex compared lowercase.
 * - Solana (base58): none.
 * - TRON: `T`. XRP: `r`. Stellar: `G` (base32, upper case).
 * - Cardano: hrp + `1` + header char (`addr1q`, `addr_test1v`, …), bech32 lowercase.
 * - NEAR: none (implicit 64 hex or named id, lowercase).
 * - Sui: `0x`, hex compared lowercase (no checksum at all).
 * - Hedera: `0x` (EVM address, hex lowercase) or `0.0.` (account number; HIP-15 checksum dropped).
 * - Kaspa: `kaspa:` / `kaspatest:` + version char (`kaspa:q`, `kaspa:p`), bech32 lowercase.
 * - Polkadot (SS58): the first char (`1` for prefix 0, `5` for prefix 42).
 */
export function addressParts(address: string, family: Family): AddressParts & { caseInsensitive: boolean } {
  const a = address.trim();
  const bech = /^([a-z_]+)1([02-9ac-hj-np-z])/i.exec(a);
  switch (family) {
    case 'evm':
    case 'sui':
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
    case 'dash':
      return { prefix: a.slice(0, 1), body: a.slice(1), caseInsensitive: false };
    case 'bch': {
      const lower = a.toLowerCase();
      const bare = lower.includes(':') ? lower.slice(lower.indexOf(':') + 1) : lower;
      return { prefix: bare.slice(0, 1), body: bare.slice(1), caseInsensitive: true };
    }
    case 'tron':
      return a.startsWith('T') ? { prefix: 'T', body: a.slice(1), caseInsensitive: false } : { prefix: '', body: a, caseInsensitive: false };
    case 'xrp':
      return a.startsWith('r') ? { prefix: 'r', body: a.slice(1), caseInsensitive: false } : { prefix: '', body: a, caseInsensitive: false };
    case 'xlm':
      return a.startsWith('G') ? { prefix: 'G', body: a.slice(1), caseInsensitive: false } : { prefix: '', body: a, caseInsensitive: false };
    case 'sol':
      return { prefix: '', body: a, caseInsensitive: false };
    case 'near':
      // Implicit (64 hex) or named account ids: always lowercase.
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
  }
}

/** Same address once normalized (case-insensitive formats compared lowercase). */
export function sameAddress(a: string, b: string, family: Family): boolean {
  const x = addressParts(a, family);
  const y = addressParts(b, family);
  // Base58 prefixes are case-sensitive (Dash `X…` ≠ `x…`); case-insensitive formats are already lowercased.
  return x.prefix === y.prefix && x.body === y.body;
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
  /** The reference address the recipient imitates. */
  known: KnownAddress;
  /**
   * Set when the recipient is ITSELF one of the references (for example a contact, or a
   * counterparty of the history) while looking like another one: one of the two may be the
   * look-alike, already saved or already paid once.
   */
  recipientKnown?: KnownAddress;
}

const ORDER: KnownSource[] = ['contact', 'own', 'sent', 'history'];

/**
 * The first reference the recipient looks like (contacts first, then own, sent from this
 * device, then the rest of the history), or null.
 *
 * An exact match with a reference does NOT end the check: the recipient is still compared with
 * every other reference. Otherwise an attacker who manages to get his look-alike into the list
 * (a zero-value `transferFrom` shown as « sent », a contact saved from the history) would silence
 * the alert on exactly the address he planted.
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
  /**
   * Zero-value or dust transfer in ANY direction, or a transfer this account did not sign (an
   * EVM / TRON `transferFrom` shown as outgoing): exactly what an address-poisoning attacker can
   * plant for free. See `isDustAmount` and `HistoryItem.suspect`.
   */
  suspect: boolean;
}

/**
 * Splits the history's counterparties:
 * - `trusted`: recipients of sends SIGNED BY THIS DEVICE (`signedHere`, from Kyro's own record of
 *   what it signed and broadcast). The server's history is never enough: anyone can make an
 *   address appear in it, even as « sent by you ».
 * - `references`: the other counterparties of the history that are not suspect. Compared with
 *   the recipient (a look-alike of them is flagged) but an exact match proves nothing.
 * - `suspects`: seen only through suspect transfers. Never a reference: comparing against them
 *   would flag the real address. They only trigger a note when the recipient is one of them.
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

/**
 * Base-unit amounts at or under which a transfer counts as dust, per chain: 10 × the network's
 * dust limit (Bitcoin 546 sat, Litecoin 294 litoshis for ltc1, Dogecoin 0,01 DOGE, Bitcoin Cash
 * and Dash 546). Planting an address in someone's history costs at least that much on these chains.
 */
const DUST_UNITS: Partial<Record<Family, bigint>> = { btc: 5_460n, ltc: 2_940n, doge: 10_000_000n, bch: 5_460n, dash: 5_460n };

/** Fiat value under which any transfer is dust (planting a look-alike costs less than that). */
export const DUST_FIAT = 1;

/**
 * Zero, under 1 (fiat) when the price is known, or under 10 × the dust limit on UTXO chains:
 * cheap enough to be a poisoning lure rather than a payment.
 */
export function isDustAmount(family: Family, amount: bigint, fiat: number | null): boolean {
  if (amount <= 0n) return true;
  if (fiat !== null && Number.isFinite(fiat) && fiat < DUST_FIAT) return true;
  const units = DUST_UNITS[family];
  return units !== undefined && amount <= units;
}
