// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — Hedera (`hbar_*`, docs/IPC.md §2.11), mirroring apps/desktop/src-tauri/src/
// commands_hbar.rs and hbar_backend.rs. The EVM address is really derived (ECDSA secp256k1
// `m/44'/3030'/0'/0/a`, keccak256 of the public key); the transaction bodies are a demo encoding
// (hex JSON, NOT the protobuf wallet-core writes) and the signature is fake. The rules are Rust's:
// - our account `0.0.x` is the one created by the first HBAR received on the EVM address;
// - recipient `0.0.x` unknown / deleted / requiring its signature → refused; an EVM address
//   without account → auto-created (higher max fee);
// - max fee = 0.5 ¢ (10 ¢ with an account creation) at the mirror's exchange rate;
//   amount + max fee > balance → refused; memo ≤ 100 bytes, no control character;
// - one body per node (0.0.3, 0.0.4, 0.0.7 mainnet / 0.0.3, 0.0.4, 0.0.5 testnet), same
//   transaction ID; sign refuses an (almost) expired body; a submitted transfer reaches the
//   mirror node a few seconds later (`hbar_tx_status`).

import { HDKey } from '@scure/bip32';
import * as ecc from '@bitcoinerlab/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  IpcError,
  type Commands,
  type HbarAccountInfo,
  type HbarBackendInfo,
  type HbarContext,
  type HbarHistoryEntry,
  type HbarOwnAccount,
  type HbarRecipientInfo,
  type HbarTxSummary,
  type HbarWarning,
  type Network,
  type Settings,
} from './ipc';
import type { DemoTor } from './mock-tor';

export const HBAR_TINYBARS = 100_000_000n;
/** Rust: valid duration 180 s; signing needs ≥ 45 s left. */
const VALID_DURATION = 180;
const MIN_REMAINING = 45;
/** Demo exchange rate: 7.18 ¢ / HBAR (testnet, 2026-11-01). */
const RATE = { cents: 215_465n, hbars: 30_000n };
const CONSENSUS_MS = 4_000;

function toChecksumAddress(hex40: string): string {
  const lower = hex40.toLowerCase();
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) out += parseInt(hash[i] ?? '0', 16) >= 8 ? (lower[i] ?? '').toUpperCase() : (lower[i] ?? '');
  return out;
}

/** EVM address (EIP-55) of Hedera account `account` (`m/44'/3030'/0'/0/account`, like Rust). */
export function demoHbarAddress(seed: Uint8Array, account: number): string {
  const pk = HDKey.fromMasterSeed(seed).derive(`m/44'/3030'/0'/0/${account}`).publicKey;
  if (!pk) throw new IpcError('INTERNAL', 'dérivation Hedera');
  return toChecksumAddress(bytesToHex(keccak_256(ecc.pointCompress(pk, false).slice(1))).slice(-40));
}

/** wallet-core `hbar_checksum` (HIP-15). */
export function hbarChecksum(network: Network, num: number | bigint): string {
  const addr = `0.0.${num}`;
  const P3 = 26n ** 3n;
  const P5 = 26n ** 5n;
  let s = 0n;
  let s0 = 0n;
  let s1 = 0n;
  let sh = 0n;
  [...addr].forEach((ch, i) => {
    const d = ch === '.' ? 10n : BigInt(ch);
    s = (31n * s + d) % P3;
    if (i % 2 === 0) s0 = (s0 + d) % 11n;
    else s1 = (s1 + d) % 11n;
  });
  for (const b of [network === 'mainnet' ? 0n : 1n, 0n, 0n, 0n, 0n, 0n, 0n]) sh = (31n * sh + b) % P5;
  let c = ((((BigInt(addr.length) % 5n) * 11n + s0) * 11n + s1) * P3 + s + sh) % P5;
  c = (c * 1_000_003n) % P5;
  let out = '';
  for (let i = 0; i < 5; i++) {
    out = String.fromCharCode(97 + Number(c % 26n)) + out;
    c /= 26n;
  }
  return out;
}

const invalidInput = (m: string) => new IpcError('INVALID_INPUT', `Entrée invalide : ${m}`);
const hbarText = (t: bigint | string | number) => {
  const v = BigInt(t);
  const frac = (v % HBAR_TINYBARS).toString().padStart(8, '0').replace(/0+$/, '');
  return `${v / HBAR_TINYBARS}${frac ? `,${frac}` : ''} HBAR`;
};

/** wallet-core `hbar_parse_recipient` (same messages). */
export function parseHbarRecipient(input: unknown, network: Network): { to: string; isEvm: boolean; num: number | null } {
  const t = String(input ?? '').trim();
  if (/^0[xX]/.test(t)) {
    const hex = t.slice(2);
    if (!/^[0-9a-fA-F]{40}$/.test(hex)) throw invalidInput('adresse EVM invalide (0x + 40 hexadécimaux, EIP-55)');
    const mixed = /[a-f]/.test(hex) && /[A-F]/.test(hex);
    if (mixed && toChecksumAddress(hex) !== `0x${hex}`) throw invalidInput('adresse EVM invalide (0x + 40 hexadécimaux, EIP-55)');
    if (/^0{24}/.test(hex)) {
      const n = BigInt(`0x${hex.slice(24)}`);
      if (n === 0n) throw invalidInput('adresse nulle refusée');
      return { to: `0.0.${n}`, isEvm: false, num: Number(n) };
    }
    return { to: toChecksumAddress(hex), isEvm: true, num: null };
  }
  const m = /^0\.0\.([1-9]\d{0,18})(?:-([a-z]{5}))?$/.exec(t);
  if (!m?.[1]) throw invalidInput(t.startsWith('0.0.') ? 'identifiant Hedera invalide' : 'identifiant Hedera attendu : 0.0.nombre');
  if (m[2] && m[2] !== hbarChecksum(network, BigInt(m[1]))) {
    throw invalidInput("somme de contrôle de l'identifiant Hedera incorrecte (ou identifiant d'un autre réseau)");
  }
  return { to: `0.0.${m[1]}`, isEvm: false, num: Number(m[1]) };
}

interface DemoHbarAccount {
  num: number;
  evm: string | null;
  balance: bigint;
  receiverSigRequired: boolean;
  deleted: boolean;
}

interface DemoBody {
  payer: number;
  node: number;
  validStart: number;
  nanos: number;
  maxFee: string;
  memo: string;
  to: string;
  amount: string;
  signature?: string;
}

export interface DemoHbarDeps {
  network: Network;
  seed: Uint8Array;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
  now: () => number;
}

export interface DemoHbarState {
  me: string;
  /** Our account number (created by the demo's first incoming transfer). */
  num: number;
  /** A funded exchange account (a memo is expected). */
  exchange: string;
  friend: string;
  /** An account that requires its own signature to receive. */
  guarded: string;
  accounts: Map<number, DemoHbarAccount>;
  history: HbarHistoryEntry[];
  submitted: Map<string, { at: number; result: string }>;
  nextNum: number;
}

export function createDemoHbar(d: DemoHbarDeps) {
  const me = demoHbarAddress(d.seed, 0);
  const nodes = d.network === 'mainnet' ? [3, 4, 7] : [3, 4, 5];
  const t0 = d.now();
  const num = d.network === 'mainnet' ? 9_284_117 : 5_031_442;
  const state: DemoHbarState = {
    me,
    num,
    exchange: '0.0.1006',
    friend: '0.0.4815162',
    guarded: '0.0.777',
    accounts: new Map([
      [num, { num, evm: me.toLowerCase(), balance: 4_250_000_000n, receiverSigRequired: false, deleted: false }],
      [1006, { num: 1006, evm: null, balance: 9_000_000_000_000_000n, receiverSigRequired: false, deleted: false }],
      [4_815_162, { num: 4_815_162, evm: null, balance: 120_000_000_000n, receiverSigRequired: false, deleted: false }],
      [777, { num: 777, evm: null, balance: 1n, receiverSigRequired: true, deleted: false }],
    ]),
    history: [
      { id: `0.0.1006-${Math.floor(t0 / 1000) - 86_400}-000000001`, name: 'CRYPTOTRANSFER', result: 'SUCCESS', time: t0 - 86_400_000, fee: '0', memo: null, delta: '2500000000', amount: '2500000000', counterparty: '0.0.1006', outgoing: false },
      { id: `0.0.4815162-${Math.floor(t0 / 1000) - 3 * 86_400}-000000002`, name: 'CRYPTOTRANSFER', result: 'SUCCESS', time: t0 - 3 * 86_400_000, fee: '0', memo: 'merci', delta: '1750000000', amount: '1750000000', counterparty: '0.0.4815162', outgoing: false },
    ],
    submitted: new Map(),
    nextNum: 9_300_001,
  };

  const torOn = () => d.settings().tor.enabled;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const backend = async () => {
    if (torOn()) await d.tor.waitReady();
    await wait(50 + Math.random() * 120);
  };
  const byEvm = (evm: string) => [...state.accounts.values()].find((a) => a.evm === evm.toLowerCase());
  const info = (a: DemoHbarAccount | undefined): HbarAccountInfo =>
    a
      ? { exists: true, accountId: `0.0.${a.num}`, evmAddress: a.evm ?? `0x${a.num.toString(16).padStart(40, '0')}`, balance: a.balance.toString(), hollow: false, deleted: a.deleted, receiverSigRequired: a.receiverSigRequired, foundBy: null }
      : { exists: false, accountId: null, evmAddress: null, balance: '0', hollow: false, deleted: false, receiverSigRequired: false, foundBy: null };
  const lookup = (to: string) => (to.startsWith('0x') ? byEvm(to) : state.accounts.get(Number(to.slice(4))));
  const ours = (): HbarAccountInfo => ({ ...info(state.accounts.get(num)), foundBy: 'alias' });

  const maxFee = (creates: boolean) => {
    const budget = creates ? 1_000n : 50n;
    const t = (budget * RATE.hbars * HBAR_TINYBARS) / (100n * RATE.cents);
    return t < 1_000_000n ? 1_000_000n : t > 500_000_000n ? 500_000_000n : t;
  };

  const contextFor = (to: string): HbarContext => {
    const recipient = info(lookup(to));
    const account = ours();
    if (recipient.deleted) throw invalidInput('ce compte Hedera est supprimé : le transfert échouerait');
    if (recipient.receiverSigRequired) throw invalidInput('ce compte Hedera exige la signature du destinataire pour recevoir : un transfert simple échouerait');
    if (!to.startsWith('0x') && !recipient.exists) throw invalidInput('ce compte Hedera n’existe pas (identifiant inconnu du nœud miroir)');
    if (recipient.accountId === account.accountId) throw invalidInput('transfert à soi-même');
    return { account, recipient, createsAccount: to.startsWith('0x') && !recipient.exists };
  };

  const checkBalance = (amount: bigint, fee: bigint, balance: string) => {
    if (amount + fee > BigInt(balance)) {
      throw invalidInput(`solde insuffisant : ${hbarText(balance)} disponibles, il en faut ${hbarText(amount + fee)} (montant + frais maximum)`);
    }
  };

  const encode = (b: DemoBody) => bytesToHex(new TextEncoder().encode(JSON.stringify(b)));
  const parse = (hex: unknown): DemoBody => {
    try {
      return JSON.parse(new TextDecoder().decode(hexToBytes(String(hex ?? '').trim().toLowerCase()))) as DemoBody;
    } catch {
      throw invalidInput('transaction Hedera illisible');
    }
  };

  /** wallet-core hbar_decode_tx: copies identical but for their node, payer = us. */
  const decode = (bodies: unknown): { b: DemoBody; summary: HbarTxSummary } => {
    if (!Array.isArray(bodies) || bodies.length === 0 || bodies.length > 4) throw invalidInput('transaction Hedera refusée : 1 à 4 copies attendues');
    const all = bodies.map(parse);
    const b = all[0] as DemoBody;
    for (const x of all) {
      if (JSON.stringify({ ...x, node: 0, signature: undefined }) !== JSON.stringify({ ...b, node: 0, signature: undefined })) throw invalidInput('transaction Hedera refusée : les copies pour plusieurs nœuds diffèrent');
      if (!nodes.includes(x.node)) throw invalidInput(`transaction Hedera refusée : nœud 0.0.${x.node} hors de la liste de Kyro`);
    }
    if (b.payer !== num) throw invalidInput('transaction Hedera refusée : le payeur n’est pas le compte de ce portefeuille');
    const warnings: HbarWarning[] = [];
    if (BigInt(b.maxFee) > 200_000_000n) warnings.push({ kind: 'highFee' });
    const summary: HbarTxSummary = {
      from: `0.0.${b.payer}`,
      to: b.to,
      toIsEvm: b.to.startsWith('0x'),
      amount: b.amount,
      maxFee: b.maxFee,
      memo: b.memo || null,
      memoHex: b.memo ? bytesToHex(new TextEncoder().encode(b.memo)) : null,
      transactionId: `0.0.${b.payer}@${b.validStart}.${String(b.nanos).padStart(9, '0')}`,
      mirrorTransactionId: `0.0.${b.payer}-${b.validStart}-${String(b.nanos).padStart(9, '0')}`,
      validStart: b.validStart,
      validDuration: VALID_DURATION,
      nodes: all.map((x) => `0.0.${x.node}`),
      warnings,
      requiresExtraConfirmation: warnings.length > 0,
    };
    return { b, summary };
  };

  /** commands_hbar.rs describe_hbar: memo framed after the amounts. */
  const describe = (s: HbarTxSummary, c: HbarContext): string => {
    const line = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    let out = `Envoi Hedera${d.network === 'testnet' ? ' (testnet)' : ''}\n\nÀ : ${s.to}${s.toIsEvm ? " (adresse EVM : l'alias du compte)" : ''}\n`;
    out += `Montant : ${hbarText(s.amount)} (${s.amount} tinybars)\n`;
    if (c.createsAccount) out += '\nCette adresse n’a pas encore de compte Hedera : ce transfert le crée (frais de création ≈ 0,05 $, payés par toi).\n';
    out += `\nFrais maximum : ${hbarText(s.maxFee)} (seuls les frais réels sont prélevés : ≈ 0,0001 $ pour un transfert)\nDepuis : ${s.from} · solde : ${hbarText(c.account.balance)}\n`;
    out += `Valable ${s.validDuration} s, identifiant ${s.transactionId}\nSignée pour ${s.nodes.length} nœud(s) (${s.nodes.join(', ')}) : même identifiant, exécutée une seule fois au plus.\n`;
    out += `${line}\n${s.memo ? `MÉMO (public à jamais) : « ${s.memo} »\n` : "AUCUN MÉMO\n(une plateforme d'échange en exige souvent un : sans lui, les fonds peuvent être perdus)\n"}${line}\n`;
    return out;
  };

  const accountArg = (v: unknown) => {
    const a = v === undefined || v === null ? 0 : Number(v);
    if (!Number.isInteger(a) || a < 0 || a > 100) throw invalidInput('numéro de compte : au plus 100');
    return a;
  };

  const handlers: Record<Extract<keyof Commands, `hbar_${string}`>, (a: Record<string, unknown>) => unknown> = {
    hbar_backend_info: (): HbarBackendInfo => ({
      network: d.network === 'mainnet' ? 'mainnet' : 'testnet',
      label: d.network === 'mainnet' ? 'mainnet-public.mirrornode.hedera.com' : 'testnet.mirrornode.hedera.com',
      tor: torOn(),
    }),
    hbar_address: (a) => {
      d.requireUnlocked();
      return demoHbarAddress(d.seed, accountArg(a.account));
    },
    hbar_account: async (a): Promise<HbarOwnAccount> => {
      d.requireUnlocked();
      const acc = accountArg(a.account);
      await backend();
      if (acc !== 0) {
        return { ...info(undefined), address: demoHbarAddress(d.seed, acc), accountIdChecksum: null };
      }
      return { ...ours(), address: me, accountIdChecksum: `0.0.${num}-${hbarChecksum(d.network, num)}` };
    },
    hbar_recipient: async (a): Promise<HbarRecipientInfo> => {
      const r = parseHbarRecipient(a.to, d.network);
      await backend();
      return { ...info(lookup(r.to)), to: r.to, isEvm: r.isEvm };
    },
    hbar_txs: async (a) => {
      const id = String(a.accountId ?? '');
      if (!/^0\.0\.\d+(-[a-z]{5})?$/.test(id)) throw invalidInput('identifiant Hedera invalide');
      await backend();
      return Number(id.slice(4).split('-')[0]) === num ? state.history.slice(0, 50) : [];
    },
    hbar_build_tx: async (a) => {
      d.requireUnlocked();
      const r = parseHbarRecipient(a.to, d.network);
      const amount = String(a.amount ?? '').trim();
      if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw invalidInput('montant en tinybars invalide');
      const memo = String(a.memo ?? '');
      if (new TextEncoder().encode(memo).length > 100) throw invalidInput('mémo trop long : 100 octets au plus');
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/.test(memo)) throw invalidInput('mémo : caractères de contrôle, invisibles ou de direction refusés');
      await backend();
      const context = contextFor(r.to);
      const fee = maxFee(context.createsAccount);
      checkBalance(BigInt(amount), fee, context.account.balance);
      const now = d.now();
      const bodies = nodes.map((node) => encode({ payer: num, node, validStart: Math.floor(now / 1000) - 10, nanos: (now % 1000) * 1_000_000 + 1, maxFee: fee.toString(), memo, to: r.to, amount }));
      return { bodies, summary: decode(bodies).summary, context };
    },
    hbar_sign_tx: async (a) => {
      d.requireUnlocked();
      const { summary } = decode(a.bodies);
      await backend();
      const context = contextFor(summary.to);
      if (d.now() / 1000 > summary.validStart + summary.validDuration - MIN_REMAINING) throw invalidInput('transfert Hedera expiré ou presque (fenêtre de 180 s) : reconstruis-le');
      checkBalance(BigInt(summary.amount), BigInt(summary.maxFee), context.account.balance);
      d.checkPassword(a.password);
      if (!d.confirm(`Confirmer le transfert Hedera\n${describe(summary, context)}`)) throw new IpcError('USER_REJECTED', 'Signature refusée.');
      if (summary.requiresExtraConfirmation && !d.confirm('Attention : transfert à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?')) throw new IpcError('USER_REJECTED', 'Signature refusée.');
      const signed = (a.bodies as string[]).map((h) => encode({ ...parse(h), signature: bytesToHex(sha256(new TextEncoder().encode(`sig:${h}`))) }));
      return { signed, summary, context };
    },
    hbar_broadcast: async (a) => {
      const { b, summary } = decode(a.signed);
      if (!b.signature) throw invalidInput('transaction Hedera non signée');
      await backend();
      if (state.submitted.has(summary.mirrorTransactionId)) return summary.transactionId; // DUPLICATE_TRANSACTION
      if (d.now() / 1000 > summary.validStart + summary.validDuration) throw invalidInput(`transfert Hedera refusé par le nœud ${summary.nodes[0]} : TRANSACTION_EXPIRED`);
      const mine = state.accounts.get(num);
      const amount = BigInt(summary.amount);
      const charged = 83_000n;
      if (!mine || mine.balance < amount + charged) throw invalidInput(`transfert Hedera refusé par le nœud ${summary.nodes[0]} : INSUFFICIENT_PAYER_BALANCE`);
      mine.balance -= amount + charged;
      let dest = lookup(summary.to);
      if (!dest && summary.toIsEvm) {
        dest = { num: state.nextNum++, evm: summary.to.toLowerCase(), balance: 0n, receiverSigRequired: false, deleted: false };
        state.accounts.set(dest.num, dest);
      }
      if (dest) dest.balance += amount;
      state.submitted.set(summary.mirrorTransactionId, { at: d.now(), result: 'SUCCESS' });
      state.history.unshift({ id: summary.mirrorTransactionId, name: 'CRYPTOTRANSFER', result: 'SUCCESS', time: d.now(), fee: charged.toString(), memo: summary.memo, delta: (-(amount + charged)).toString(), amount: amount.toString(), counterparty: dest ? `0.0.${dest.num}` : summary.to, outgoing: true });
      return summary.transactionId;
    },
    hbar_tx_status: async (a) => {
      const id = String(a.id ?? '').trim();
      const m = /^0\.0\.(\d+)[@-](\d+)[.-](\d{1,9})$/.exec(id);
      if (!m) throw invalidInput('identifiant de transaction Hedera invalide');
      await backend();
      const s = state.submitted.get(`0.0.${m[1]}-${m[2]}-${(m[3] ?? '').padStart(9, '0')}`);
      if (!s || d.now() - s.at < CONSENSUS_MS) return { found: false, result: '' };
      return { found: true, result: s.result };
    },
  };

  return { state, handlers };
}
