// SPDX-License-Identifier: GPL-3.0-or-later
//
// TON user-friendly addresses (48 characters, base64url or base64 of tag ‖ workchain ‖ hash ‖
// CRC16-XModem), the same rules as wallet-core `ton_parse_address`: checksum, tag 0x11
// (bounceable `EQ…`) / 0x51 (non-bounceable `UQ…`), + 0x80 testnet-only (`kQ…` / `0Q…`),
// workchain 0 or -1. Raw `0:…` forms are refused (no checksum). Used by the interface to give
// early feedback and by the demo backend; Rust re-checks everything on every command.

export interface TonFriendlyAddress {
  workchain: number;
  /** 32-byte account id, lower-case hex. */
  hash: string;
  bounceable: boolean;
  testnet: boolean;
}

/** CRC-16/XMODEM (poly 0x1021, init 0). */
export function crc16Xmodem(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64decode(s: string): Uint8Array | null {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  if (t.length % 4 !== 0) return null;
  const out: number[] = [];
  for (let i = 0; i < t.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => B64.indexOf(t[i + k] ?? ''));
    if (v.some((x) => x < 0)) return null;
    const [a, b, c, d] = v as [number, number, number, number];
    out.push((a << 2) | (b >> 4), ((b & 15) << 4) | (c >> 2), ((c & 3) << 6) | d);
  }
  return new Uint8Array(out);
}

function b64urlEncode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const [x = 0, y = 0, z = 0] = [b[i], b[i + 1], b[i + 2]];
    const n = (x << 16) | (y << 8) | z;
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  return s.replace(/\+/g, '-').replace(/\//g, '_');
}

/** Why `s` is not a valid user-friendly TON address, or null. */
export function tonAddressProblem(s: string): string | null {
  const a = s.trim();
  if (a.includes(':')) return 'adresse TON brute (0:…) refusée : utilise la forme lisible EQ… / UQ…, qui a une somme de contrôle';
  if (a.length !== 48) return 'adresse TON invalide (48 caractères attendus)';
  if (/[-_]/.test(a) && /[+/]/.test(a)) return 'adresse TON invalide (base64 mélangé)';
  const b = b64decode(a);
  if (!b || b.length !== 36) return 'adresse TON invalide';
  const crc = crc16Xmodem(b.slice(0, 34));
  if (b[34] !== crc >> 8 || b[35] !== (crc & 0xff)) return 'adresse TON invalide (somme de contrôle)';
  const tag = (b[0] ?? 0) & 0x7f;
  if (tag !== 0x11 && tag !== 0x51) return 'adresse TON invalide (indicateur inconnu)';
  if (b[1] !== 0 && b[1] !== 0xff) return 'adresse TON invalide (chaîne de travail inconnue)';
  return null;
}

export function parseTonAddress(s: string): TonFriendlyAddress | null {
  if (tonAddressProblem(s)) return null;
  const b = b64decode(s.trim());
  if (!b) return null;
  let hash = '';
  for (const x of b.slice(2, 34)) hash += x.toString(16).padStart(2, '0');
  return { workchain: b[1] === 0xff ? -1 : 0, hash, bounceable: ((b[0] ?? 0) & 0x7f) === 0x11, testnet: ((b[0] ?? 0) & 0x80) !== 0 };
}

/** User-friendly base64url form of `workchain:hash`. */
export function tonFriendly(workchain: number, hashHex: string, bounceable: boolean, testnet: boolean): string {
  const b = new Uint8Array(36);
  b[0] = (bounceable ? 0x11 : 0x51) | (testnet ? 0x80 : 0);
  b[1] = workchain === -1 ? 0xff : 0;
  for (let i = 0; i < 32; i++) b[2 + i] = parseInt(hashHex.slice(2 * i, 2 * i + 2), 16);
  const crc = crc16Xmodem(b.slice(0, 34));
  b[34] = crc >> 8;
  b[35] = crc & 0xff;
  return b64urlEncode(b);
}

/** Same account? (`EQ…` and `UQ…` forms of one account are equal.) */
export function sameTonAccount(a: string, b: string): boolean {
  const x = parseTonAddress(a);
  const y = parseTonAddress(b);
  return !!x && !!y && x.workchain === y.workchain && x.hash === y.hash;
}
