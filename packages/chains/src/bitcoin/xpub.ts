// SPDX-License-Identifier: GPL-3.0-or-later
//
// Public-only BIP32 derivation from the account xpub returned by `accounts_get`.
// No private key ever exists in JS.

import { HDKey } from '@scure/bip32';

const VERSIONS = [
  { public: 0x0488b21e, private: 0x0488ade4 }, // xpub
  { public: 0x043587cf, private: 0x04358394 }, // tpub
  { public: 0x04b24746, private: 0x04b2430c }, // zpub
  { public: 0x045f1cf6, private: 0x045f18bc }, // vpub
  { public: 0x049d7cb2, private: 0x049d7878 }, // ypub
  { public: 0x044a5262, private: 0x044a4e28 }, // upub
];

export function parseXpub(xpub: string): HDKey {
  for (const v of VERSIONS) {
    try {
      const key = HDKey.fromExtendedKey(xpub, v);
      if (key.privateKey) throw new Error('Clé privée étendue refusée');
      return key;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Clé privée')) throw e;
    }
  }
  throw new Error('xpub invalide ou version inconnue');
}

/** Compressed 33-byte pubkey at `change/index`. */
export function derivePubkey(account: HDKey, change: 0 | 1, index: number): Uint8Array {
  const pk = account.deriveChild(change).deriveChild(index).publicKey;
  if (!pk) throw new Error('Dérivation impossible');
  return pk;
}

export function fingerprintBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) throw new Error('Empreinte invalide');
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}
