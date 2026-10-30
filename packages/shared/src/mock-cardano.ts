// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — Cardano (`ada_*`, docs/IPC.md §2.7), mirroring apps/desktop/src-tauri/src/
// commands_cardano.rs and cardano_backend.rs. The demo account is a FIXED published address
// (Trezor `all ×12` / CIP-19 fixture), not derived from the demo seed (Icarus BIP32-Ed25519 is
// not reimplemented here); the transaction is a demo encoding (hex JSON, NOT CBOR) and the
// witness is fake. The rules are Rust's, with its French messages:
// - addresses: Byron, script (types 1, 3, 5, 7), pointer (4, 5), stake (14, 15) and other-network
//   addresses refused; base (0, 2) and enterprise (6) accepted;
// - min-UTxO = (160 + output size) × coinsPerUtxoByte (Babbage/Conway), iterated like wallet-core;
// - fee = min_fee_a × signed size + min_fee_b, iterated; one recipient output + one change output
//   carrying every leftover token, each at or above its min-UTxO; ttl = slot + 3 600;
// - coin selection: UTxOs with the requested token first, then ADA-only by decreasing value,
//   token-carrying ones last; CIP-20 memo (64-byte lines, 1 024 bytes max.);
// - signing re-reads the UTxOs live (inputs unspent, inputs = outputs + fee), refuses an expired
//   ttl; warnings (memo, unverified token, fee > 5 ADA) → reinforced confirmation.
//
// Scenario words in a custom Koios URL: « down » → SERVER_UNREACHABLE, « wrong » →
// SERVER_WRONG_NETWORK.

import { bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  IpcError,
  type CardanoAccount,
  type CardanoAddressInfo,
  type CardanoBackendInfo,
  type CardanoContext,
  type CardanoHistoryEntry,
  type CardanoOutputView,
  type CardanoServer,
  type CardanoTokenBalance,
  type CardanoTokenView,
  type CardanoTxSummary,
  type CardanoWarning,
  type Commands,
  type Network,
  type ServerTestResult,
  type Settings,
} from './ipc';
import { checkServerUrl } from './servers';
import type { DemoTor } from './mock-tor';

/** Preprod protocol parameters (Koios `epoch_params`). */
export const ADA_PARAMS = { minFeeA: 44, minFeeB: 155_381, coinsPerByte: 4_310, maxTxSize: 16_384 };
const TTL_OFFSET = 3_600;
const MAX_INPUTS = 50;
const HIGH_FEE = 5_000_000n;
/** Trezor `all ×12` m/1852'/1815'/0'/0/0, preprod form (CIP-19 test-vector style). */
const DEMO_ADDRESS_TESTNET = 'addr_test1qrv42wjda8r6mpfj40d36znlgfdcqp7jtj03ah8skh6u8wnrqua2vw243tmjfjt0h5wsru6appuz8c0pfd75ur7myyeqnsc9fs';
/** Verified tokens: mainnet only, same table as cardano_backend.rs VERIFIED_MAINNET. */
const VERIFIED_MAINNET: Array<{ policy: string; name: string; ticker: string; decimals: number }> = [
  { policy: '8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61', name: '446a65644d6963726f555344', ticker: 'DJED', decimals: 6 },
  { policy: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad', name: '0014df105553444d', ticker: 'USDM', decimals: 6 },
  { policy: 'f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880', name: '69555344', ticker: 'iUSD', decimals: 6 },
];

const hrpOf = (net: Network) => (net === 'mainnet' ? 'addr' : 'addr_test');
const stakeHrpOf = (net: Network) => (net === 'mainnet' ? 'stake' : 'stake_test');
const netId = (net: Network) => (net === 'mainnet' ? 1 : 0);
const invalidInput = (m: string) => new IpcError('INVALID_INPUT', `Entrée invalide : ${m}`);
const unreachable = (m: string) => new IpcError('SERVER_UNREACHABLE', `Serveur injoignable : ${m}`);
const has = (s: string, w: string) => s.toLowerCase().includes(w);
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};

/** Rust `format_units(raw, 6)`: comma decimal, trailing zeros trimmed. */
export function adaUnits(lovelace: bigint | string | number): string {
  const v = BigInt(lovelace);
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${v / 1_000_000n}${frac ? `,${frac}` : ''}`;
}

/** bech32 encode of address bytes. */
export function cardanoAddressOf(bytes: Uint8Array, hrp: string): string {
  return bech32.encode(hrp, bech32.toWords(bytes), 1023);
}

/** wallet-core `cardano_address_bytes`: same acceptance rules and messages. */
export function cardanoAddressBytes(address: unknown, net: Network): Uint8Array {
  const a = String(address ?? '').trim();
  if (a.startsWith('Ae2') || a.startsWith('DdzFF') || a.startsWith('37btjrVyb4K')) {
    throw invalidInput('les adresses Byron ne sont pas prises en charge : demande au destinataire une adresse Shelley (addr1…)');
  }
  let prefix: string;
  let data: Uint8Array;
  try {
    const d = bech32.decode(a as `${string}1${string}`, 1023);
    prefix = d.prefix;
    data = bech32.fromWords(d.words);
  } catch {
    throw invalidInput('adresse Cardano invalide');
  }
  if (prefix !== hrpOf(net)) {
    // A stake address of the right network gets its own message (header check below).
    if (prefix !== stakeHrpOf(net)) throw invalidInput("adresse Cardano d'un autre réseau, ou pas une adresse de paiement");
  }
  const header = data[0];
  if (header === undefined) throw invalidInput('adresse vide');
  const kind = header >> 4;
  if ((header & 0x0f) !== netId(net)) throw invalidInput("adresse Cardano d'un autre réseau");
  if ((kind === 0 || kind === 2) && data.length === 57 && prefix === hrpOf(net)) return data;
  if (kind === 6 && data.length === 29 && prefix === hrpOf(net)) return data;
  if (kind === 1 || kind === 3 || kind === 7) throw invalidInput('adresses de script refusées : un paiement sans datum pourrait bloquer les fonds');
  if (kind === 4 || kind === 5) throw invalidInput('adresses pointeur obsolètes (Conway) : refusées');
  if (kind === 14 || kind === 15) throw invalidInput('une adresse de staking (stake…) ne peut pas recevoir de paiement');
  if (kind === 8) throw invalidInput('les adresses Byron ne sont pas prises en charge');
  throw invalidInput('adresse Cardano mal formée');
}

/** Demo account address on `net` (the preprod fixture, re-encoded for mainnet). */
export function demoCardanoAddress(net: Network): string {
  const d = bech32.decode(DEMO_ADDRESS_TESTNET as `${string}1${string}`, 1023);
  const bytes = bech32.fromWords(d.words);
  bytes[0] = ((bytes[0] ?? 0) & 0xf0) | netId(net);
  return cardanoAddressOf(bytes, hrpOf(net));
}

// ---------------------------------------------------------------- CBOR sizes (output, body)

const uintSize = (n: bigint | number) => {
  const v = BigInt(n);
  return v < 24n ? 1 : v < 256n ? 2 : v < 65_536n ? 3 : v < 4_294_967_296n ? 5 : 9;
};
const lenSize = (n: number) => (n < 24 ? 1 : n < 256 ? 2 : n < 65_536 ? 3 : 5);
const bytesSize = (n: number) => lenSize(n) + n;

/** `${policy}.${name}` → quantity. */
type Assets = Map<string, bigint>;

function assetsSize(assets: Assets): number {
  const byPolicy = new Map<string, Array<[string, bigint]>>();
  for (const [k, q] of assets) {
    const [p = '', n = ''] = k.split('.');
    byPolicy.set(p, [...(byPolicy.get(p) ?? []), [n, q]]);
  }
  let size = lenSize(byPolicy.size);
  for (const names of byPolicy.values()) {
    size += bytesSize(28) + lenSize(names.length);
    for (const [n, q] of names) size += bytesSize(n.length / 2) + uintSize(q);
  }
  return size;
}

/** Output `[address, coin | [coin, multiasset]]` (legacy array form, like wallet-core). */
function outputSize(addressLen: number, coin: bigint, assets: Assets): number {
  const value = assets.size === 0 ? uintSize(coin) : 1 + uintSize(coin) + assetsSize(assets);
  return 1 + bytesSize(addressLen) + value;
}

/** wallet-core `cardano_min_utxo`: (160 + size) × coinsPerUtxoByte, coin at its final width. */
export function minUtxo(addressLen: number, assets: Assets, coinsPerByte = ADA_PARAMS.coinsPerByte): bigint {
  let coin = 1_000_000n;
  for (let i = 0; i < 4; i++) {
    const need = BigInt(160 + outputSize(addressLen, coin, assets)) * BigInt(coinsPerByte);
    if (need === coin) break;
    coin = need;
  }
  return coin;
}

/** CIP-20 lines: ≤ 64 UTF-8 bytes each (wallet-core `cardano_cip20_aux`). */
function memoLines(message: string): string[] {
  const lines: string[] = [];
  let cur = '';
  const enc = new TextEncoder();
  for (const ch of message) {
    if (enc.encode(cur).length + enc.encode(ch).length > 64) {
      lines.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) lines.push(cur);
  if (lines.length === 0) throw invalidInput('message vide');
  if (enc.encode(message).length > 1024) throw invalidInput('message trop long (1 024 octets max.)');
  return lines;
}

function auxSize(lines: string[] | null): number {
  if (!lines) return 0;
  const enc = new TextEncoder();
  return 1 + uintSize(674) + 1 + bytesSize(3) + lenSize(lines.length) + lines.reduce((s, l) => s + bytesSize(enc.encode(l).length), 0);
}

/** Signed size: body + one vkey witness + auxiliary data (close to wallet-core's encoding). */
function signedSize(inputs: number, outputs: Array<{ addressLen: number; coin: bigint; assets: Assets }>, fee: bigint, ttl: number, lines: string[] | null): number {
  const body =
    1 + // map
    1 + 3 + lenSize(inputs) + inputs * (1 + bytesSize(32) + uintSize(10)) + // 0: tag 258 set of inputs
    1 + lenSize(outputs.length) + outputs.reduce((s, o) => s + outputSize(o.addressLen, o.coin, o.assets), 0) + // 1
    1 + uintSize(fee) + // 2
    1 + uintSize(ttl) + // 3
    (lines ? 1 + bytesSize(32) : 0); // 7: auxiliary data hash
  const witnesses = 1 + 1 + 3 + 1 + 1 + bytesSize(32) + bytesSize(64); // {0: 258[[vkey, sig]]}
  return 1 + body + witnesses + 1 + (lines ? auxSize(lines) : 1);
}

// ---------------------------------------------------------------- state

interface DemoUtxo {
  txHash: string;
  index: number;
  lovelace: bigint;
  assets: Assets;
}

interface DemoAdaTx {
  txId: string;
  inputs: string[];
  outputs: Array<{ address: string; lovelace: string; tokens: Array<{ policy: string; name: string; quantity: string }> }>;
  fee: string;
  ttl: number;
  memo: string[] | null;
  witness?: string;
}

export interface DemoCardanoDeps {
  network: Network;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
  now: () => number;
}

export interface DemoCardanoState {
  me: string;
  /** Another base address (a friend). */
  friend: string;
  /** Demo token policies (preprod, unverified). */
  policies: { kyro: string; hosky: string };
  utxos: Map<string, DemoUtxo[]>;
  history: CardanoHistoryEntry[];
  submitted: Map<string, number>;
}

const hex = (s: string) => bytesToHex(new TextEncoder().encode(s));
const printable = (nameHex: string): string | null => {
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(nameHex));
    return t && !/\p{Cc}/u.test(t) ? t : null;
  } catch {
    return null;
  }
};

export function createDemoCardano(d: DemoCardanoDeps) {
  const netKey = d.network === 'mainnet' ? 'mainnet' : 'testnet';
  const me = demoCardanoAddress(d.network);
  const meBytes = cardanoAddressBytes(me, d.network);
  const friendBytes = new Uint8Array([netId(d.network), ...sha256(new TextEncoder().encode('kyro-demo-ada-friend')).slice(0, 28), ...sha256(new TextEncoder().encode('kyro-demo-ada-friend-stake')).slice(0, 28)]);
  const friend = cardanoAddressOf(friendBytes, hrpOf(d.network));
  const policy = (label: string) => bytesToHex(sha256(new TextEncoder().encode(label)).slice(0, 28));
  const policies = { kyro: policy('kyro-demo-policy-ktest'), hosky: policy('kyro-demo-policy-thosky') };
  const t0 = d.now();
  const txh = (label: string) => bytesToHex(sha256(new TextEncoder().encode(label)));
  const state: DemoCardanoState = {
    me,
    friend,
    policies,
    utxos: new Map([
      [
        me,
        [
          { txHash: txh('ada-u1'), index: 0, lovelace: 1_250_000_000n, assets: new Map() },
          { txHash: txh('ada-u2'), index: 1, lovelace: 3_000_000n, assets: new Map([[`${policies.kyro}.${hex('KyroTest')}`, 5_000n]]) },
          { txHash: txh('ada-u3'), index: 0, lovelace: 1_400_000n, assets: new Map([[`${policies.hosky}.${hex('tHOSKY')}`, 1_000_000n]]) },
        ],
      ],
    ]),
    history: [
      { hash: txh('ada-u3'), time: t0 - 86_400_000, blockHeight: 2_901_200, fee: '170297', lovelaceDelta: '1400000', tokenDeltas: [{ policy: policies.hosky, name: hex('tHOSKY'), nameText: 'tHOSKY', delta: '1000000' }], memo: 'airdrop de test' },
      { hash: txh('ada-u2'), time: t0 - 2 * 86_400_000, blockHeight: 2_898_441, fee: '171573', lovelaceDelta: '3000000', tokenDeltas: [{ policy: policies.kyro, name: hex('KyroTest'), nameText: 'KyroTest', delta: '5000' }], memo: null },
      { hash: txh('ada-u1'), time: t0 - 4 * 86_400_000, blockHeight: 2_890_015, fee: '168801', lovelaceDelta: '1250000000', tokenDeltas: [], memo: null },
    ],
    submitted: new Map(),
  };
  const slotNow = () => (d.network === 'mainnet' ? 140_000_000 : 72_000_000) + Math.floor((d.now() - t0) / 1000);
  const tip = () => ({ slot: slotNow(), blockHeight: 2_901_300 + Math.floor((d.now() - t0) / 20_000), epoch: d.network === 'mainnet' ? 590 : 230 });

  const torOn = () => d.settings().tor.enabled;
  const serverOf = (): CardanoServer => d.settings().servers.cardano?.[netKey] ?? { kind: 'default' };
  const defaultHost = d.network === 'mainnet' ? 'api.koios.rest' : 'preprod.koios.rest';
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const backend = async () => {
    const s = serverOf();
    if (s.kind === 'koios') {
      const bad = checkServerUrl(s.url, torOn());
      if (bad) throw new IpcError('SERVER_INVALID', `Serveur invalide : ${bad}`);
    }
    if (torOn()) await d.tor.waitReady();
    await wait(60 + Math.random() * 140);
    if (s.kind === 'koios' && has(s.url, 'down')) throw unreachable(`${hostOf(s.url)} : délai de connexion dépassé`);
  };

  const verifiedEntry = (p: string, n: string) => (d.network === 'mainnet' ? VERIFIED_MAINNET.find((v) => v.policy === p && v.name === n) : undefined);
  const tokenView = (k: string, q: bigint): CardanoTokenView => {
    const [p = '', n = ''] = k.split('.');
    return { policy: p, name: n, nameText: printable(n), quantity: q.toString(), verified: !!verifiedEntry(p, n) };
  };

  const accountOf = (address: string): CardanoAccount => {
    const bytes = cardanoAddressBytes(address, d.network);
    const utxos = state.utxos.get(address) ?? [];
    let balance = 0n;
    let locked = 0n;
    const tokens = new Map<string, bigint>();
    for (const u of utxos) {
      balance += u.lovelace;
      for (const [k, q] of u.assets) tokens.set(k, (tokens.get(k) ?? 0n) + q);
      if (u.assets.size > 0) locked += minUtxo(bytes.length, u.assets);
    }
    const list: CardanoTokenBalance[] = [...tokens.entries()].sort().map(([k, q]) => {
      const v = tokenView(k, q);
      const e = verifiedEntry(v.policy, v.name);
      return { ...v, ...(e ? { ticker: e.ticker, decimals: e.decimals } : {}) };
    });
    return { address: address.trim(), balance: balance.toString(), tokens: list, utxoCount: utxos.length, lockedWithTokens: (locked < balance ? locked : balance).toString() };
  };

  /** cardano_backend::plan + finish: selection, fee iteration, min-UTxO checks. */
  const plan = (toBytes: Uint8Array, to: string, lovelace: bigint | null, token: { key: string; q: bigint } | null, lines: string[] | null) => {
    const send: Assets = token ? new Map([[token.key, token.q]]) : new Map();
    const minTo = minUtxo(toBytes.length, send);
    let coin: bigint;
    if (lovelace !== null) {
      if (lovelace < minTo) throw invalidInput(`montant trop faible : cette sortie doit porter au moins ${adaUnits(minTo)} ADA (min-UTxO${send.size ? ', avec le token' : ''})`);
      coin = lovelace;
    } else if (send.size) coin = minTo;
    else throw invalidInput('montant ADA manquant');
    const utxos = [...(state.utxos.get(me) ?? [])];
    utxos.sort((a, b) => {
      const ka = [token && a.assets.has(token.key) ? 0 : 1, a.assets.size ? 1 : 0];
      const kb = [token && b.assets.has(token.key) ? 0 : 1, b.assets.size ? 1 : 0];
      return ka[0]! - kb[0]! || ka[1]! - kb[1]! || (b.lovelace > a.lovelace ? 1 : b.lovelace < a.lovelace ? -1 : 0);
    });
    const chosen: DemoUtxo[] = [];
    let lastErr: IpcError | null = null;
    for (const u of utxos) {
      if (chosen.length >= MAX_INPUTS) break;
      chosen.push(u);
      try {
        return finish(chosen, toBytes, to, send, coin, lines);
      } catch (e) {
        if (!(e instanceof IpcError) || e.code !== 'INVALID_INPUT') throw e;
        lastErr = e;
      }
    }
    throw lastErr ?? invalidInput('aucun UTxO : adresse vide');
  };

  const finish = (chosen: DemoUtxo[], toBytes: Uint8Array, to: string, send: Assets, coin: bigint, lines: string[] | null): DemoAdaTx => {
    let inCoin = 0n;
    const left: Assets = new Map();
    for (const u of chosen) {
      inCoin += u.lovelace;
      for (const [k, q] of u.assets) left.set(k, (left.get(k) ?? 0n) + q);
    }
    for (const [k, q] of send) {
      const have = left.get(k) ?? 0n;
      if (have < q) throw invalidInput(`token insuffisant : ${have} disponible(s), ${q} demandé(s)`);
      if (have === q) left.delete(k);
      else left.set(k, have - q);
    }
    const minChange = minUtxo(meBytes.length, left);
    const ttl = slotNow() + TTL_OFFSET;
    let fee = BigInt(ADA_PARAMS.minFeeB);
    for (let i = 0; i < 6; i++) {
      const need = coin + fee;
      if (inCoin < need) throw invalidInput(`solde insuffisant : ${adaUnits(inCoin)} ADA en entrée, il faut ${adaUnits(need)} ADA (montant + frais)`);
      const rest = inCoin - need;
      if (rest < minChange) throw invalidInput(`la monnaie rendue (${adaUnits(rest)} ADA) serait sous son minimum de ${adaUnits(minChange)} ADA (min-UTxO) : envoie un peu moins`);
      const outs = [
        { addressLen: toBytes.length, coin, assets: send },
        { addressLen: meBytes.length, coin: rest, assets: left },
      ];
      const size = signedSize(chosen.length, outs, fee, ttl, lines);
      if (size > ADA_PARAMS.maxTxSize) throw invalidInput(`transaction trop grande (${size} octets, maximum ${ADA_PARAMS.maxTxSize})`);
      const req = BigInt(ADA_PARAMS.minFeeA * size + ADA_PARAMS.minFeeB);
      if (fee >= req) {
        const tokens = (a: Assets) => [...a.entries()].sort().map(([k, q]) => ({ policy: k.split('.')[0] ?? '', name: k.split('.')[1] ?? '', quantity: q.toString() }));
        return {
          txId: '',
          inputs: chosen.map((u) => `${u.txHash}#${u.index}`).sort(),
          outputs: [
            { address: to, lovelace: coin.toString(), tokens: tokens(send) },
            { address: me, lovelace: rest.toString(), tokens: tokens(left) },
          ],
          fee: fee.toString(),
          ttl,
          memo: lines,
        };
      }
      fee = req;
    }
    throw new IpcError('INTERNAL', 'Erreur interne : calcul des frais Cardano instable');
  };

  const encode = (t: DemoAdaTx) => bytesToHex(new TextEncoder().encode(JSON.stringify(t)));
  const bodyId = (t: DemoAdaTx) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify({ ...t, txId: '', witness: undefined }))));

  /** wallet-core decode: outputs as views (min-UTxO, change, verified), warnings. */
  const decode = (txHex: unknown): { t: DemoAdaTx; summary: CardanoTxSummary } => {
    let t: DemoAdaTx;
    try {
      t = JSON.parse(new TextDecoder().decode(hexToBytes(String(txHex ?? '').trim()))) as DemoAdaTx;
    } catch {
      throw invalidInput('transaction : hexadécimal attendu');
    }
    const warnings: CardanoWarning[] = [];
    if (t.memo) warnings.push({ kind: 'memo' });
    const outputs: CardanoOutputView[] = t.outputs.map((o) => {
      const bytes = cardanoAddressBytes(o.address, d.network);
      const assets: Assets = new Map(o.tokens.map((k) => [`${k.policy}.${k.name}`, BigInt(k.quantity)]));
      const isChange = o.address === me;
      const tokens = [...assets.entries()].map(([k, q]) => tokenView(k, q));
      if (!isChange) for (const k of tokens) if (!k.verified) warnings.push({ kind: 'unknownToken', policy: k.policy, name: k.name });
      return { address: o.address, kind: (bytes[0]! >> 4) === 6 ? 'enterprise' : 'base', isChange, lovelace: o.lovelace, tokens, minLovelace: minUtxo(bytes.length, assets).toString() };
    });
    if (BigInt(t.fee) > HIGH_FEE) warnings.push({ kind: 'highFee' });
    const summary: CardanoTxSummary = { txId: bodyId(t), inputs: t.inputs, outputs, fee: t.fee, ttl: t.ttl, validFrom: null, memo: t.memo, warnings, requiresExtraConfirmation: warnings.length > 0 };
    return { t, summary };
  };

  /** cardano_backend::check_balance against the live UTxO set. Returns lovelace leaving. */
  const checkBalance = (t: DemoAdaTx): bigint => {
    const ours = state.utxos.get(me) ?? [];
    let inCoin = 0n;
    const inAssets: Assets = new Map();
    for (const i of t.inputs) {
      const [h, idx] = i.split('#');
      const u = ours.find((x) => x.txHash === h && String(x.index) === idx);
      if (!u) throw invalidInput(`entrée ${h}#${idx} inconnue ou déjà dépensée : reconstruis la transaction`);
      inCoin += u.lovelace;
      for (const [k, q] of u.assets) inAssets.set(k, (inAssets.get(k) ?? 0n) + q);
    }
    let outCoin = BigInt(t.fee);
    let leaving = BigInt(t.fee);
    const outAssets: Assets = new Map();
    for (const o of t.outputs) {
      outCoin += BigInt(o.lovelace);
      if (o.address !== me) leaving += BigInt(o.lovelace);
      for (const k of o.tokens) outAssets.set(`${k.policy}.${k.name}`, (outAssets.get(`${k.policy}.${k.name}`) ?? 0n) + BigInt(k.quantity));
    }
    const same = inAssets.size === outAssets.size && [...inAssets].every(([k, q]) => outAssets.get(k) === q);
    if (inCoin !== outCoin || !same) throw invalidInput('transaction déséquilibrée (entrées ≠ sorties + frais) : refusée');
    return leaving;
  };

  const context = (leaving: bigint): CardanoContext => ({ account: accountOf(me), params: { ...ADA_PARAMS }, tip: tip(), leaving: leaving.toString() });

  /** commands_cardano.rs describe_ada: every output, tokens, min-ADA, fee, total, ttl, memo. */
  const describe = (s: CardanoTxSummary, c: CardanoContext): string => {
    let out = `Envoi Cardano${d.network === 'testnet' ? ' (preprod)' : ''}\n`;
    s.outputs.forEach((o, i) => {
      out += `\nSortie ${i + 1} — ${o.isChange ? 'monnaie rendue (ton adresse)' : 'DESTINATAIRE'}\n  ${o.address}\n  ${adaUnits(o.lovelace)} ADA${o.tokens.length ? ` (dont ${adaUnits(o.minLovelace)} ADA minimum obligatoire avec les tokens)` : ''}\n`;
      for (const t of o.tokens) {
        const name = t.nameText ? `« ${t.nameText} » (hex ${t.name || 'vide'})` : t.name ? `hex ${t.name}` : '(nom vide)';
        out += `    + ${t.quantity} × ${name}${t.verified ? '  ✓ vérifié' : '  ⚠ NON VÉRIFIÉ'}\n      policy ${t.policy}\n`;
      }
      if (o.kind === 'enterprise') out += '  (adresse « enterprise » : sans partie staking)\n';
    });
    out += `\nFrais : ${adaUnits(s.fee)} ADA (${s.fee} lovelace)\nTotal qui quitte le portefeuille : ${adaUnits(c.leaving)} ADA\n`;
    out += s.ttl !== null ? `Valable jusqu'au slot ${s.ttl} (≈ ${Math.floor(Math.max(0, s.ttl - c.tip.slot) / 60)} min)\n` : 'AUCUNE LIMITE DE VALIDITÉ (ttl absent)\n';
    if (s.memo) out += `Message (CIP-20, public à jamais) : ${s.memo.join('')}\n`;
    out += `\nSolde : ${adaUnits(c.account.balance)} ADA · ${s.inputs.length} entrée(s) · id ${s.txId}\n`;
    return out;
  };

  const probe = async (network: string, s: CardanoServer): Promise<ServerTestResult['detected']> => {
    if (network !== 'mainnet' && network !== 'testnet') throw new IpcError('SERVER_INVALID', `Serveur invalide : cardano : réseau inconnu « ${network} » (mainnet ou testnet)`);
    if (s.kind === 'koios') {
      const bad = checkServerUrl(s.url, torOn());
      if (bad) throw new IpcError('SERVER_INVALID', `Serveur invalide : cardano ${network} : ${bad}`);
    }
    if (torOn()) await d.tor.waitReady();
    await wait(100 + Math.random() * 200);
    if (s.kind === 'koios' && has(s.url, 'down')) throw unreachable(`${hostOf(s.url)} : délai de connexion dépassé`);
    const want = network === 'mainnet' ? 'mainnet' : 'preprod';
    if (s.kind === 'koios' && has(s.url, 'wrong')) throw new IpcError('SERVER_WRONG_NETWORK', `Mauvais réseau : ce serveur Cardano est sur ${want === 'mainnet' ? 'preprod' : 'mainnet'}, pas sur ${want}`);
    return { network: want, chainId: network === 'mainnet' ? 764_824_073 : 1, blockHeight: tip().blockHeight };
  };

  const handlers: Record<Extract<keyof Commands, `ada_${string}`>, (a: Record<string, unknown>) => unknown> = {
    ada_backend_info: (): CardanoBackendInfo => {
      const s = serverOf();
      return { kind: s.kind, network: netKey, label: s.kind === 'koios' ? hostOf(s.url) : defaultHost, tor: torOn() };
    },
    ada_address: (a): CardanoAddressInfo => {
      d.requireUnlocked();
      const index = Number(a.index);
      if (!Number.isInteger(index) || index < 0 || index > 2 ** 31 - 1) throw invalidInput("index d'adresse trop grand");
      if (index !== 0) throw invalidInput('démo : seule l’adresse d’index 0 existe (Kyro ne signe que celle-là)');
      const stake = new Uint8Array([0xe0 | netId(d.network), ...meBytes.slice(29)]);
      return { address: me, path: "m/1852'/1815'/0'/0/0", stakeAddress: cardanoAddressOf(stake, stakeHrpOf(d.network)), accountXpub: bytesToHex(sha256(new TextEncoder().encode('demo-ada-xpub'))).repeat(2) };
    },
    ada_account: async (a) => {
      const addr = String(a.address ?? '').trim();
      cardanoAddressBytes(addr, d.network);
      await backend();
      return accountOf(addr);
    },
    ada_txs: async (a) => {
      cardanoAddressBytes(a.address, d.network);
      await backend();
      return String(a.address).trim() === me ? state.history.slice(0, 20) : [];
    },
    ada_tx_status: async (a) => {
      const h = String(a.hash ?? '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(h)) throw invalidInput('hash : 64 caractères hexadécimaux');
      await backend();
      const at = state.submitted.get(h);
      if (at === undefined) return { confirmations: state.history.some((t) => t.hash === h) ? 12 : null };
      const n = Math.floor((d.now() - at) / 5_000);
      return { confirmations: n > 0 ? n : null };
    },
    ada_build_tx: async (a) => {
      d.requireUnlocked();
      const to = String(a.to ?? '').trim();
      const toBytes = cardanoAddressBytes(to, d.network);
      const lovelaceIn = a.lovelace === undefined || a.lovelace === null || String(a.lovelace).trim() === '' ? null : String(a.lovelace).trim();
      if (lovelaceIn !== null && (!/^\d+$/.test(lovelaceIn) || BigInt(lovelaceIn) <= 0n)) throw invalidInput('montant en lovelace invalide');
      const tk = a.token as { policy?: unknown; name?: unknown; quantity?: unknown } | undefined;
      let token: { key: string; q: bigint } | null = null;
      if (tk) {
        const policyHex = String(tk.policy ?? '').trim().toLowerCase();
        const nameHex = String(tk.name ?? '').trim().toLowerCase();
        if (!/^[0-9a-f]{56}$/.test(policyHex) || nameHex.length > 64 || !/^([0-9a-f]{2})*$/.test(nameHex)) throw invalidInput('token : policy (56 hex) et nom (hex, 32 octets max.)');
        const q = String(tk.quantity ?? '').trim();
        if (!/^\d+$/.test(q)) throw invalidInput('quantité de token invalide');
        if (BigInt(q) === 0n) throw invalidInput('quantité de token nulle');
        token = { key: `${policyHex}.${nameHex}`, q: BigInt(q) };
      }
      const memo = typeof a.memo === 'string' && a.memo.trim() ? memoLines(a.memo.trim()) : null;
      await backend();
      const t = plan(toBytes, to, lovelaceIn === null ? null : BigInt(lovelaceIn), token, memo);
      const tx = encode(t);
      const { summary } = decode(tx);
      return { tx, summary, context: context(checkBalance(t)) };
    },
    ada_sign_tx: async (a) => {
      d.requireUnlocked();
      const { t, summary } = decode(a.tx);
      await backend();
      if (summary.ttl !== null && summary.ttl <= slotNow()) throw invalidInput('transaction Cardano expirée (ttl dépassé) : reconstruis-la');
      const leaving = checkBalance(t);
      const minFee = BigInt(ADA_PARAMS.minFeeA * signedSize(t.inputs.length, t.outputs.map((o) => ({ addressLen: cardanoAddressBytes(o.address, d.network).length, coin: BigInt(o.lovelace), assets: new Map(o.tokens.map((k) => [`${k.policy}.${k.name}`, BigInt(k.quantity)])) })), BigInt(t.fee), t.ttl, t.memo) + ADA_PARAMS.minFeeB);
      if (BigInt(t.fee) < minFee) throw invalidInput(`frais trop bas : ${adaUnits(t.fee)} ADA, minimum ${adaUnits(minFee)} ADA`);
      d.checkPassword(a.password);
      const c = context(leaving);
      if (!d.confirm(`Confirmer la transaction Cardano\n${describe(summary, c)}`)) throw new IpcError('USER_REJECTED', 'Signature refusée.');
      if (summary.requiresExtraConfirmation && !d.confirm('Attention : transaction à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?')) throw new IpcError('USER_REJECTED', 'Signature refusée.');
      const signed = encode({ ...t, witness: bytesToHex(sha256(new TextEncoder().encode(`witness:${summary.txId}`))) });
      return { tx: signed, txId: summary.txId, summary, context: c };
    },
    ada_broadcast: async (a) => {
      const { t, summary } = decode(a.tx);
      if (!t.witness) throw invalidInput('transaction Cardano non signée (aucun témoin)');
      await backend();
      checkBalance(t);
      // Spend the inputs, add the change (ours) as a new UTxO.
      const ours = state.utxos.get(me) ?? [];
      state.utxos.set(
        me,
        ours.filter((u) => !t.inputs.includes(`${u.txHash}#${u.index}`)),
      );
      t.outputs.forEach((o, index) => {
        if (o.address !== me && o.address !== friend) return;
        const list = state.utxos.get(o.address) ?? [];
        list.push({ txHash: summary.txId, index, lovelace: BigInt(o.lovelace), assets: new Map(o.tokens.map((k) => [`${k.policy}.${k.name}`, BigInt(k.quantity)])) });
        state.utxos.set(o.address, list);
      });
      const sent = t.outputs.filter((o) => o.address !== me);
      const delta = -(sent.reduce((s, o) => s + BigInt(o.lovelace), 0n) + BigInt(t.fee));
      const tokenDeltas = sent.flatMap((o) => o.tokens.map((k) => ({ policy: k.policy, name: k.name, nameText: printable(k.name), delta: `-${k.quantity}` })));
      state.history.unshift({ hash: summary.txId, time: d.now(), blockHeight: tip().blockHeight + 1, fee: t.fee, lovelaceDelta: delta.toString(), tokenDeltas, memo: t.memo ? t.memo.join('') : null });
      state.submitted.set(summary.txId, d.now());
      return summary.txId;
    },
  };

  return {
    state,
    handlers,
    probe,
    validate: (servers: Settings['servers'], tor: boolean) => {
      for (const nk of ['mainnet', 'testnet'] as const) {
        const s = servers.cardano?.[nk];
        if (s?.kind === 'koios') {
          const bad = checkServerUrl(s.url, tor);
          if (bad) throw new IpcError('SERVER_INVALID', `Serveur invalide : cardano ${nk} : ${bad}`);
        }
      }
    },
  };
}
