#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// BIP39 phrase to BIP32 master key, with Node's standard library only and no Kyro code. Bitcoin
// Core has no BIP39: this is the one step it cannot do, see docs/BTC_TIMELOCK.md.
//
//   node scripts/btc-phrase-to-xprv.mjs mainnet
//   node scripts/btc-phrase-to-xprv.mjs testnet
//
// The phrase is read from standard input, so it stays out of the shell history. If the wallet has
// a BIP39 passphrase, put it in KYRO_BIP39_PASSPHRASE. Run this offline: the output spends the coins.

import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';

const VERSION = { mainnet: 0x0488ade4, testnet: 0x04358394 };
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const sha256 = (b) => createHash('sha256').update(b).digest();

function base58check(payload) {
  const data = Buffer.concat([payload, sha256(sha256(payload)).subarray(0, 4)]);
  let n = BigInt(`0x${data.toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of data) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const network = process.argv[2];
if (!(network in VERSION)) {
  console.error('usage: node btc-phrase-to-xprv.mjs mainnet|testnet  (phrase on standard input)');
  process.exit(2);
}
const phrase = readFileSync(0, 'utf8').trim().split(/\s+/).join(' ').normalize('NFKD');
const salt = `mnemonic${process.env.KYRO_BIP39_PASSPHRASE ?? ''}`.normalize('NFKD');
const seed = pbkdf2Sync(phrase, salt, 2048, 64, 'sha512');
const i = createHmac('sha512', 'Bitcoin seed').update(seed).digest();

const payload = Buffer.alloc(78);
payload.writeUInt32BE(VERSION[network], 0); // depth, parent fingerprint and child number stay zero
i.subarray(32).copy(payload, 13); // chain code
i.subarray(0, 32).copy(payload, 46); // 0x00 at 45, then the key
console.log(base58check(payload));
