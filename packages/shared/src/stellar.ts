// SPDX-License-Identifier: GPL-3.0-or-later
//
// Stellar strkeys (SEP-0023), TS side: the same rules as wallet-core's `stellar_account_id`, so
// the interface can say early what Rust will refuse. Rust still checks every address itself.
// Version byte ‖ payload ‖ CRC16-XModem (little endian), RFC 4648 base32 without padding,
// canonical only (the text must re-encode to itself).

import { base32nopad } from '@scure/base';

const VERSION_ACCOUNT = 6 << 3; // G
const VERSION_MUXED = 12 << 3; // M
const VERSION_SEED = 18 << 3; // S

/** CRC16-XModem (polynomial 0x1021, initial value 0). */
export function crc16Xmodem(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function encode(version: number, payload: Uint8Array): string {
  const data = new Uint8Array(payload.length + 3);
  data[0] = version;
  data.set(payload, 1);
  const crc = crc16Xmodem(data.subarray(0, payload.length + 1));
  data[payload.length + 1] = crc & 0xff;
  data[payload.length + 2] = crc >> 8;
  return base32nopad.encode(data);
}

function decode(s: string): { version: number; payload: Uint8Array } | null {
  if (!/^[A-Z2-7]+$/.test(s) || [1, 3, 6].includes(s.length % 8)) return null;
  let raw: Uint8Array;
  try {
    raw = base32nopad.decode(s);
  } catch {
    return null;
  }
  if (raw.length < 3) return null;
  const body = raw.subarray(0, raw.length - 2);
  const crc = crc16Xmodem(body);
  if (raw[raw.length - 2] !== (crc & 0xff) || raw[raw.length - 1] !== crc >> 8) return null;
  const version = body[0] ?? -1;
  const payload = body.slice(1);
  // Round trip: one text per key (non-zero unused bits are refused here).
  return encode(version, payload) === s ? { version, payload } : null;
}

/** `G…` address of a 32-byte ed25519 public key. */
export function stellarAddressOfKey(key: Uint8Array): string {
  if (key.length !== 32) throw new Error('clé Stellar : 32 octets attendus');
  return encode(VERSION_ACCOUNT, key);
}

/** What a pasted string is: an account `G…`, a muxed `M…`, a SECRET key `S…`, or nothing valid. */
export function stellarAddressKind(address: string): 'account' | 'muxed' | 'secret' | 'invalid' {
  const d = decode(address.trim());
  if (!d) return 'invalid';
  if (d.version === VERSION_ACCOUNT && d.payload.length === 32) return 'account';
  if (d.version === VERSION_MUXED && d.payload.length === 40) return 'muxed';
  if (d.version === VERSION_SEED && d.payload.length === 32) return 'secret';
  return 'invalid';
}

/** A valid `G…` account address (checksum and canonical form checked). */
export function isStellarAddress(address: string): boolean {
  return stellarAddressKind(address) === 'account';
}

/** Public key of a `G…` address, or null. */
export function stellarAccountKey(address: string): Uint8Array | null {
  const d = decode(address.trim());
  return d && d.version === VERSION_ACCOUNT && d.payload.length === 32 ? d.payload : null;
}

/** 1 XLM = 10 000 000 stroops. */
export const STROOPS_PER_XLM = 10_000_000n;
