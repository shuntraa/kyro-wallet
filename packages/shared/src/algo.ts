// SPDX-License-Identifier: GPL-3.0-or-later
//
// Algorand address format, for the interface only (Rust checks every address again with
// wallet-core `algo_address_bytes`): 58 upper-case base32 characters (RFC 4648, no padding) of
// the 32-byte public key followed by the last 4 bytes of its SHA-512/256.

import { base32nopad } from '@scure/base';
import { sha512_256 } from '@noble/hashes/sha2';

/** Address of 32 public bytes. */
export function algoAddressOf(pk: Uint8Array): string {
  return base32nopad.encode(new Uint8Array([...pk, ...sha512_256(pk).slice(28)]));
}

/** Format and checksum of an Algorand address. */
export function isAlgoAddress(address: string): boolean {
  const a = address.trim();
  if (!/^[A-Z2-7]{58}$/.test(a)) return false;
  try {
    const raw = base32nopad.decode(a);
    if (raw.length !== 36) return false;
    const sum = sha512_256(raw.slice(0, 32)).slice(28);
    return raw.slice(32).every((b, i) => b === sum[i]) && algoAddressOf(raw.slice(0, 32)) === a;
  } catch {
    return false;
  }
}
