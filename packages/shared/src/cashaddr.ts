// SPDX-License-Identifier: GPL-3.0-or-later
//
// CashAddr, the Bitcoin Cash address format (spec: bitcoincash.org `spec/cashaddr.md`, read
// 2026-11-01), mirror of wallet-core `cashaddr.rs`. `prefix:payload`, payload = base32
// (bech32's alphabet) of `version byte ‖ hash`, then an 8-symbol BCH-code checksum over the
// prefix's low 5 bits, a zero separator and the payload. Not cryptography: a checksum. The
// 8↔5-bit regrouping and the alphabet are `@scure/base`'s (audited); only the spec's `PolyMod`
// is written here. Checked against every spec vector (`test/cashaddr.test.ts`) and against
// Rust's addresses (same "abandon … about" / "all ×12" vectors).
//
// The TypeScript side only uses it to derive and compare addresses (the adapter's scan and
// its consistency check with Rust); Rust re-validates every address it is given.

import { utils } from '@scure/base';
import { l10n } from './i18n';

const ALPHABET = utils.alphabet('qpzry9x8gf2tvdw0s3jn54khce6mua7l');
const GENERATOR = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
/** Hash sizes in bits, indexed by the version byte's size bits. */
const SIZES = [160, 192, 224, 256, 320, 384, 448, 512];

/** Bitcoin Cash mainnet / chipnet prefixes. */
export const CASHADDR_PREFIX = { mainnet: 'bitcoincash', testnet: 'bchtest' } as const;

function polymod(values: number[]): bigint {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GENERATOR[i]!;
  }
  return c ^ 1n;
}

function prefixWords(prefix: string): number[] {
  if (!/^[a-z0-9]+$/.test(prefix)) throw new Error(l10n('Préfixe CashAddr invalide', 'Invalid CashAddr prefix'));
  return [...prefix].map((ch) => ch.charCodeAt(0) & 0x1f).concat(0);
}

/** `prefix:…` of `hash` with address type `type` (0 = P2PKH `q…`, 1 = P2SH `p…`). */
export function cashaddrEncode(prefix: string, type: number, hash: Uint8Array): string {
  const size = SIZES.indexOf(hash.length * 8);
  if (size < 0) throw new Error(l10n('Taille de hash CashAddr invalide', 'Invalid CashAddr hash size'));
  if (!Number.isInteger(type) || type < 0 || type > 15) throw new Error(l10n('Type CashAddr invalide', 'Invalid CashAddr type'));
  const words = utils.convertRadix2([(type << 3) | size, ...hash], 8, 5, true);
  const mod = polymod([...prefixWords(prefix), ...words, 0, 0, 0, 0, 0, 0, 0, 0]);
  const check: number[] = [];
  for (let i = 7; i >= 0; i--) check.push(Number((mod >> BigInt(5 * i)) & 31n));
  return `${prefix}:${ALPHABET.encode([...words, ...check]).join('')}`;
}

/**
 * Decodes a CashAddr of `prefix` (the prefix may be omitted; mixed case refused). Throws on a
 * bad checksum, non-zero padding, a reserved version bit or a hash/size mismatch.
 */
export function cashaddrDecode(address: string, prefix: string): { type: number; hash: Uint8Array } {
  const a = address.trim();
  if (a !== a.toLowerCase() && a !== a.toUpperCase()) throw new Error(l10n('CashAddr : casse mélangée', 'CashAddr: mixed case'));
  const lower = a.toLowerCase();
  const sep = lower.indexOf(':');
  const found = sep >= 0 ? lower.slice(0, sep) : prefix;
  const payload = sep >= 0 ? lower.slice(sep + 1) : lower;
  if (found !== prefix) throw new Error(l10n(`CashAddr d'un autre réseau (${found})`, `CashAddr from another network (${found})`));
  if (payload.length <= 8 || payload.length > 112) throw new Error(l10n('CashAddr : longueur invalide', 'CashAddr: invalid length'));
  const words = ALPHABET.decode(payload.split(''));
  if (polymod([...prefixWords(prefix), ...words]) !== 0n) throw new Error(l10n('CashAddr : somme de contrôle invalide', 'CashAddr: invalid checksum'));
  const bytes = utils.convertRadix2(words.slice(0, -8), 5, 8, false);
  const version = bytes[0];
  if (version === undefined || version & 0x80) throw new Error(l10n('CashAddr : version invalide', 'CashAddr: invalid version'));
  const hash = Uint8Array.from(bytes.slice(1));
  if (hash.length * 8 !== SIZES[version & 7]) throw new Error(l10n('CashAddr : taille incohérente', 'CashAddr: inconsistent size'));
  return { type: (version >> 3) & 15, hash };
}

/** scriptPubKey of a P2PKH / P2SH CashAddr (20-byte hash, types 0–3; others refused). */
export function cashaddrToScript(address: string, prefix: string): Uint8Array {
  const { type, hash } = cashaddrDecode(address, prefix);
  if (hash.length !== 20) throw new Error(l10n('CashAddr : seuls P2PKH et P2SH (20 octets) sont acceptés', 'CashAddr: only P2PKH and P2SH (20 bytes) are accepted'));
  if (type === 0 || type === 2) return Uint8Array.from([0x76, 0xa9, 0x14, ...hash, 0x88, 0xac]);
  if (type === 1 || type === 3) return Uint8Array.from([0xa9, 0x14, ...hash, 0x87]);
  throw new Error(l10n('CashAddr : type non pris en charge', 'CashAddr: unsupported type'));
}

/** CashAddr of a P2PKH / P2SH script, `null` for any other script. */
export function scriptToCashaddr(script: Uint8Array, prefix: string): string | null {
  const s = script;
  if (s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac) {
    return cashaddrEncode(prefix, 0, s.slice(3, 23));
  }
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87) return cashaddrEncode(prefix, 1, s.slice(2, 22));
  return null;
}
