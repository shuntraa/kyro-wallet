#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// From a BIP39 phrase to the one key of one time lock, for Bitcoin Core, with Node's standard
// library only and no Kyro code. Core has no BIP39: this is the step it cannot do. See
// docs/BTC_TIMELOCK.md.
//
//   node scripts/btc-lock-key.mjs --network mainnet --t 1804982400 --account 0 --from 0 --out import.json
//
// The phrase and the passphrase are asked at a prompt that does not echo, or read as the first two
// lines of standard input when it is not a terminal. They never go on the command line. The output
// is the single key at m/84'/coin'/account'/2/<day>: it can spend this lock and nothing else in the
// wallet. It goes in the --out file, never on the screen. Standard output is public: path, public
// descriptor. Refuses what Kyro's own import would refuse: a typo gives an error, never a key.

import { createECDH, createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** SHA-256 of `bip-0039/english.txt` in bitcoin/bips. */
const WORDLIST_SHA256 = '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda';
const NETWORKS = { mainnet: { coin: 0, wif: 0x80 }, testnet: { coin: 1, wif: 0xef } };
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const DAY = 86_400;
const LAST_DAY = 24_855; // 2038-01-19: miniscript's after() stops at 2^31
const HARDENED = 0x80000000;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const sha256 = (b) => createHash('sha256').update(b).digest();

function wordlist() {
  const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'bip39-english.txt'));
  if (sha256(raw).toString('hex') !== WORDLIST_SHA256) fail('bip39-english.txt is not the BIP39 list');
  return raw.toString('utf8').trim().split('\n');
}

/** Same rules as `Mnemonic::parse`: split on whitespace, lowercase, then BIP39 in full. */
function parsePhrase(input) {
  const words = input.trim().split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
  if (![12, 15, 18, 21, 24].includes(words.length)) fail(`invalid recovery phrase: ${words.length} words`);
  const list = wordlist();
  let bits = '';
  words.forEach((w, i) => {
    const index = list.indexOf(w);
    if (index < 0) fail(`invalid recovery phrase: word ${i + 1} is not in the BIP39 list`);
    bits += index.toString(2).padStart(11, '0');
  });
  const checksumBits = bits.length / 33;
  const entropyBits = bits.slice(0, bits.length - checksumBits);
  const entropy = Buffer.from(entropyBits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const expected = [...sha256(entropy)].map((b) => b.toString(2).padStart(8, '0')).join('').slice(0, checksumBits);
  if (expected !== bits.slice(bits.length - checksumBits)) fail('invalid recovery phrase: the checksum does not match, check the words');
  return words.join(' ');
}

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

function publicKey(key) {
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(key);
  return ecdh.getPublicKey(null, 'compressed');
}

/** BIP32 private derivation. */
function child({ key, chain }, index) {
  const i = Buffer.alloc(4);
  i.writeUInt32BE(index >>> 0);
  const data = index >= HARDENED ? Buffer.concat([Buffer.alloc(1), key, i]) : Buffer.concat([publicKey(key), i]);
  const h = createHmac('sha512', chain).update(data).digest();
  const left = BigInt(`0x${h.subarray(0, 32).toString('hex')}`);
  const next = (left + BigInt(`0x${key.toString('hex')}`)) % CURVE_ORDER;
  if (left >= CURVE_ORDER || next === 0n) fail('this index gives no valid key');
  return { key: Buffer.from(next.toString(16).padStart(64, '0'), 'hex'), chain: h.subarray(32) };
}

/** BIP380 descriptor checksum. */
function checksum(desc) {
  const input = '0123456789()[],\'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#"\\ ';
  const output = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const gen = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];
  const step = (c, val) => {
    const top = c >> 35n;
    let next = ((c & 0x7ffffffffn) << 5n) ^ val;
    gen.forEach((g, i) => {
      if ((top >> BigInt(i)) & 1n) next ^= g;
    });
    return next;
  };
  let c = 1n;
  let group = 0n;
  let count = 0;
  for (const ch of desc) {
    const pos = BigInt(input.indexOf(ch));
    c = step(c, pos & 31n);
    group = group * 3n + (pos >> 5n);
    if (++count === 3) {
      c = step(c, group);
      group = 0n;
      count = 0;
    }
  }
  if (count > 0) c = step(c, group);
  for (let i = 0; i < 8; i++) c = step(c, 0n);
  c ^= 1n;
  return Array.from({ length: 8 }, (_, j) => output[Number((c >> BigInt(5 * (7 - j))) & 31n)]).join('');
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) {
    if (fallback === undefined) fail(`--${name} is required`);
    return fallback;
  }
  return process.argv[i + 1];
}

/** A prompt that does not echo. */
function askHidden(question) {
  return new Promise((resolve) => {
    process.stderr.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (text) => {
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function secrets() {
  if (process.stdin.isTTY) {
    const phrase = await askHidden('Recovery phrase (hidden): ');
    const passphrase = await askHidden('BIP39 passphrase, if you set one (hidden, else Enter): ');
    return { phrase, passphrase };
  }
  const [phrase = '', passphrase = ''] = readFileSync(0, 'utf8').split(/\r?\n/);
  return { phrase, passphrase };
}

const network = NETWORKS[arg('network')];
if (!network) fail('--network mainnet or testnet');
const t = Number(arg('t'));
if (!Number.isInteger(t) || t < 500_000_000 || t % DAY !== 0 || t / DAY > LAST_DAY) fail('--t: Unix time of 00:00 UTC of the date, 2038-01-19 at the latest');
const account = Number(arg('account', '0'));
if (!Number.isInteger(account) || account < 0 || account >= HARDENED) fail('--account: 0 for the first account');
const from = Number(arg('from', '0'));
if (!Number.isInteger(from) || from < 0) fail('--from: Unix time to rescan from, 0 for the whole chain');
const out = arg('out');

const { phrase, passphrase } = await secrets();
const words = parsePhrase(phrase);
const seed = pbkdf2Sync(words.normalize('NFKD'), `mnemonic${passphrase}`.normalize('NFKD'), 2048, 64, 'sha512');
const i = createHmac('sha512', 'Bitcoin seed').update(seed).digest();
let node = { key: i.subarray(0, 32), chain: i.subarray(32) };
const day = t / DAY;
for (const index of [84 + HARDENED, network.coin + HARDENED, account + HARDENED, 2, day]) node = child(node, index);

const wif = base58check(Buffer.concat([Buffer.from([network.wif]), node.key, Buffer.from([1])]));
const withSum = (d) => `${d}#${checksum(d)}`;
const request = [{ desc: withSum(`wsh(and_v(v:pk(${wif}),after(${t})))`), timestamp: from }];
// `wx`: never over an older file, and readable by this user alone where the system allows it.
writeFileSync(out, `${JSON.stringify(request)}\n`, { flag: 'wx', mode: 0o600 });

console.log(`path:   m/84'/${network.coin}'/${account}'/2/${day}`);
console.log(`public: ${withSum(`wsh(and_v(v:pk(${publicKey(node.key).toString('hex')}),after(${t})))`)}`);
console.log(`key file: ${out} (one key, this lock only; delete it once imported)`);
