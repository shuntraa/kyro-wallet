// SPDX-License-Identifier: GPL-3.0-or-later
// DEMO ONLY — Hedera (`hbar_*`, docs/IPC.md §2.11), mirroring apps/desktop/src-tauri/src/

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
import { decimalMark, l10n } from './i18n';
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
  if (!pk) throw new IpcError('INTERNAL', l10n('dérivation Hedera', 'Hedera derivation'));
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

const invalidInput = (m: string) => new IpcError('INVALID_INPUT', l10n(`Entrée invalide : ${m}`, `Invalid input: ${m}`));
const hbarText = (t: bigint | string | number) => {
  const v = BigInt(t);
  const frac = (v % HBAR_TINYBARS).toString().padStart(8, '0').replace(/0+$/, '');
  return `${v / HBAR_TINYBARS}${frac ? `${decimalMark()}${frac}` : ''} HBAR`;
};

/** wallet-core `hbar_parse_recipient` (same messages). */
export function parseHbarRecipient(input: unknown, network: Network): { to: string; isEvm: boolean; num: number | null } {
  const t = String(input ?? '').trim();
  if (/^0[xX]/.test(t)) {
    const hex = t.slice(2);
    if (!/^[0-9a-fA-F]{40}$/.test(hex)) throw invalidInput(l10n('adresse EVM invalide (0x + 40 hexadécimaux, EIP-55)', 'invalid EVM address (0x + 40 hex characters, EIP-55)'));
    const mixed = /[a-f]/.test(hex) && /[A-F]/.test(hex);
    if (mixed && toChecksumAddress(hex) !== `0x${hex}`) throw invalidInput(l10n('adresse EVM invalide (0x + 40 hexadécimaux, EIP-55)', 'invalid EVM address (0x + 40 hex characters, EIP-55)'));
    if (/^0{24}/.test(hex)) {
      const n = BigInt(`0x${hex.slice(24)}`);
      if (n === 0n) throw invalidInput(l10n('adresse nulle refusée', 'zero address refused'));
      return { to: `0.0.${n}`, isEvm: false, num: Number(n) };
    }
    return { to: toChecksumAddress(hex), isEvm: true, num: null };
  }
  const m = /^0\.0\.([1-9]\d{0,18})(?:-([a-z]{5}))?$/.exec(t);
  if (!m?.[1]) throw invalidInput(t.startsWith('0.0.') ? l10n('identifiant Hedera invalide', 'invalid Hedera ID') : l10n('identifiant Hedera attendu : 0.0.nombre', 'Hedera ID expected: 0.0.number'));
  if (m[2] && m[2] !== hbarChecksum(network, BigInt(m[1]))) {
    throw invalidInput(l10n("somme de contrôle de l'identifiant Hedera incorrecte (ou identifiant d'un autre réseau)", 'incorrect Hedera ID checksum (or ID from another network)'));
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
  num: number;
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
    if (recipient.deleted) throw invalidInput(l10n('ce compte Hedera est supprimé : le transfert échouerait', 'this Hedera account is deleted: the transfer would fail'));
    if (recipient.receiverSigRequired) throw invalidInput(l10n('ce compte Hedera exige la signature du destinataire pour recevoir : un transfert simple échouerait', 'this Hedera account requires the recipient\'s signature to receive: a simple transfer would fail'));
    if (!to.startsWith('0x') && !recipient.exists) throw invalidInput(l10n('ce compte Hedera n’existe pas (identifiant inconnu du nœud miroir)', 'this Hedera account does not exist (ID unknown to the mirror node)'));
    if (recipient.accountId === account.accountId) throw invalidInput(l10n('transfert à soi-même', 'transfer to yourself'));
    return { account, recipient, createsAccount: to.startsWith('0x') && !recipient.exists };
  };

  const checkBalance = (amount: bigint, fee: bigint, balance: string) => {
    if (amount + fee > BigInt(balance)) {
      throw invalidInput(l10n(`solde insuffisant : ${hbarText(balance)} disponibles, il en faut ${hbarText(amount + fee)} (montant + frais maximum)`, `insufficient balance: ${hbarText(balance)} available, ${hbarText(amount + fee)} needed (amount + maximum fee)`));
    }
  };

  const encode = (b: DemoBody) => bytesToHex(new TextEncoder().encode(JSON.stringify(b)));
  const parse = (hex: unknown): DemoBody => {
    try {
      return JSON.parse(new TextDecoder().decode(hexToBytes(String(hex ?? '').trim().toLowerCase()))) as DemoBody;
    } catch {
      throw invalidInput(l10n('transaction Hedera illisible', 'unreadable Hedera transaction'));
    }
  };

  const decode = (bodies: unknown): { b: DemoBody; summary: HbarTxSummary } => {
    if (!Array.isArray(bodies) || bodies.length === 0 || bodies.length > 4) throw invalidInput(l10n('transaction Hedera refusée : 1 à 4 copies attendues', 'Hedera transaction refused: 1 to 4 copies expected'));
    const all = bodies.map(parse);
    const b = all[0] as DemoBody;
    for (const x of all) {
      if (JSON.stringify({ ...x, node: 0, signature: undefined }) !== JSON.stringify({ ...b, node: 0, signature: undefined })) throw invalidInput(l10n('transaction Hedera refusée : les copies pour plusieurs nœuds diffèrent', 'Hedera transaction refused: the copies for several nodes differ'));
      if (!nodes.includes(x.node)) throw invalidInput(l10n(`transaction Hedera refusée : nœud 0.0.${x.node} hors de la liste de Kyro`, `Hedera transaction refused: node 0.0.${x.node} not in Kyro's list`));
    }
    if (b.payer !== num) throw invalidInput(l10n('transaction Hedera refusée : le payeur n’est pas le compte de ce portefeuille', 'Hedera transaction refused: the payer is not this wallet\'s account'));
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

  const describe = (s: HbarTxSummary, c: HbarContext): string => {
    const line = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    let out = l10n(`Envoi Hedera${d.network === 'testnet' ? ' (testnet)' : ''}\n\nÀ : ${s.to}${s.toIsEvm ? " (adresse EVM : l'alias du compte)" : ''}\n`, `Hedera send${d.network === 'testnet' ? ' (testnet)' : ''}\n\nTo: ${s.to}${s.toIsEvm ? ' (EVM address: the account alias)' : ''}\n`);
    out += l10n(`Montant : ${hbarText(s.amount)} (${s.amount} tinybars)\n`, `Amount: ${hbarText(s.amount)} (${s.amount} tinybars)\n`);
    if (c.createsAccount) out += l10n('\nCette adresse n’a pas encore de compte Hedera : ce transfert le crée (frais de création ≈ 0,05 $, payés par toi).\n', '\nThis address has no Hedera account yet: this transfer creates it (creation fee ≈ $0.05, paid by you).\n');
    out += l10n(`\nFrais maximum : ${hbarText(s.maxFee)} (seuls les frais réels sont prélevés : ≈ 0,0001 $ pour un transfert)\nDepuis : ${s.from} · solde : ${hbarText(c.account.balance)}\n`, `\nMaximum fee: ${hbarText(s.maxFee)} (only the actual fee is charged: ≈ $0.0001 for a transfer)\nFrom: ${s.from} · balance: ${hbarText(c.account.balance)}\n`);
    out += l10n(`Valable ${s.validDuration} s, identifiant ${s.transactionId}\nSignée pour ${s.nodes.length} nœud(s) (${s.nodes.join(', ')}) : même identifiant, exécutée une seule fois au plus.\n`, `Valid ${s.validDuration} s, ID ${s.transactionId}\nSigned for ${s.nodes.length} node(s) (${s.nodes.join(', ')}): same ID, executed at most once.\n`);
    out += `${line}\n${s.memo ? l10n(`MÉMO (public à jamais) : « ${s.memo} »\n`, `MEMO (public forever): “${s.memo}”\n`) : l10n("AUCUN MÉMO\n(une plateforme d'échange en exige souvent un : sans lui, les fonds peuvent être perdus)\n", 'NO MEMO\n(an exchange often requires one: without it, the funds may be lost)\n')}${line}\n`;
    return out;
  };

  const accountArg = (v: unknown) => {
    const a = v === undefined || v === null ? 0 : Number(v);
    if (!Number.isInteger(a) || a < 0 || a > 100) throw invalidInput(l10n('numéro de compte : au plus 100', 'account number: at most 100'));
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
      if (!/^0\.0\.\d+(-[a-z]{5})?$/.test(id)) throw invalidInput(l10n('identifiant Hedera invalide', 'invalid Hedera ID'));
      await backend();
      return Number(id.slice(4).split('-')[0]) === num ? state.history.slice(0, 50) : [];
    },
    hbar_build_tx: async (a) => {
      d.requireUnlocked();
      const r = parseHbarRecipient(a.to, d.network);
      const amount = String(a.amount ?? '').trim();
      if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw invalidInput(l10n('montant en tinybars invalide', 'invalid tinybar amount'));
      const memo = String(a.memo ?? '');
      if (new TextEncoder().encode(memo).length > 100) throw invalidInput(l10n('mémo trop long : 100 octets au plus', 'memo too long: 100 bytes at most'));
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/.test(memo)) throw invalidInput(l10n('mémo : caractères de contrôle, invisibles ou de direction refusés', 'memo: control, invisible or direction characters refused'));
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
      if (d.now() / 1000 > summary.validStart + summary.validDuration - MIN_REMAINING) throw invalidInput(l10n('transfert Hedera expiré ou presque (fenêtre de 180 s) : reconstruis-le', 'Hedera transfer expired or nearly (180 s window): rebuild it'));
      checkBalance(BigInt(summary.amount), BigInt(summary.maxFee), context.account.balance);
      d.checkPassword(a.password);
      if (!d.confirm(l10n(`Confirmer le transfert Hedera\n${describe(summary, context)}`, `Confirm the Hedera transfer\n${describe(summary, context)}`))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      if (summary.requiresExtraConfirmation && !d.confirm(l10n('Attention : transfert à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?', 'Warning: transfer to check\nOnly sign if you know exactly why. Sign anyway?'))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      const signed = (a.bodies as string[]).map((h) => encode({ ...parse(h), signature: bytesToHex(sha256(new TextEncoder().encode(`sig:${h}`))) }));
      return { signed, summary, context };
    },
    hbar_broadcast: async (a) => {
      const { b, summary } = decode(a.signed);
      if (!b.signature) throw invalidInput(l10n('transaction Hedera non signée', 'Hedera transaction not signed'));
      await backend();
      if (state.submitted.has(summary.mirrorTransactionId)) return summary.transactionId; // DUPLICATE_TRANSACTION
      if (d.now() / 1000 > summary.validStart + summary.validDuration) throw invalidInput(l10n(`transfert Hedera refusé par le nœud ${summary.nodes[0]} : TRANSACTION_EXPIRED`, `Hedera transfer rejected by node ${summary.nodes[0]}: TRANSACTION_EXPIRED`));
      const mine = state.accounts.get(num);
      const amount = BigInt(summary.amount);
      const charged = 83_000n;
      if (!mine || mine.balance < amount + charged) throw invalidInput(l10n(`transfert Hedera refusé par le nœud ${summary.nodes[0]} : INSUFFICIENT_PAYER_BALANCE`, `Hedera transfer rejected by node ${summary.nodes[0]}: INSUFFICIENT_PAYER_BALANCE`));
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
      if (!m) throw invalidInput(l10n('identifiant de transaction Hedera invalide', 'invalid Hedera transaction ID'));
      await backend();
      const s = state.submitted.get(`0.0.${m[1]}-${m[2]}-${(m[3] ?? '').padStart(9, '0')}`);
      if (!s || d.now() - s.at < CONSENSUS_MS) return { found: false, result: '' };
      return { found: true, result: s.result };
    },
    // Tokens (USDC): not simulated in the demo.
    hbar_token_holdings: async () => {
      await backend();
      return [];
    },
    hbar_build_associate_tx: () => Promise.reject(invalidInput(l10n('démo : jetons Hedera non simulés', 'demo: Hedera tokens are not simulated'))),
    hbar_build_token_tx: () => Promise.reject(invalidInput(l10n('démo : jetons Hedera non simulés', 'demo: Hedera tokens are not simulated'))),
  };

  return { state, handlers };
}
