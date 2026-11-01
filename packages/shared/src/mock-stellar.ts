// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — Stellar (`stellar_*`, docs/IPC.md §2.11), mirroring apps/desktop/src-tauri/src/
// commands_stellar.rs and stellar_backend.rs. Addresses are valid strkeys of a demo key (NOT the
// SEP-0005 derivation wallet-core does); the envelope is a demo encoding (base64 JSON, NOT XDR)
// and the signature is fake. The rules are Rust's:
// - reserve = (2 + subentries) × 0.5 XLM; spendable = balance − reserve;
// - destination with `config.memo_required` (SEP-0029) and no memo → refused; unfunded
//   destination → CreateAccount, at least 1 XLM (2 × base reserve); amount + fee > spendable →
//   refused; our account not created → refused;
// - M… (muxed) addresses and S… secret keys refused with their own messages;
// - sign re-reads everything live, refuses an expired transaction or a stale sequence number;
// - Horizon answers the submission once the transaction is in a ledger (≈ 5 s).

import { sha256 } from '@noble/hashes/sha2';
import { base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils';
import {
  IpcError,
  type Commands,
  type Network,
  type Settings,
  type StellarAccountInfo,
  type StellarBackendInfo,
  type StellarContext,
  type StellarHistoryEntry,
  type StellarMemoSpec,
  type StellarMemoView,
  type StellarOpView,
  type StellarTxSummary,
} from './ipc';
import { stellarAddressKind, stellarAddressOfKey } from './stellar';
import type { DemoTor } from './mock-tor';

export const STELLAR_BASE_RESERVE = 5_000_000n;
const BASE_FEE = 100n;
/** Rust: maxTime = latest ledger close + 300 s. */
const VALIDITY_SECS = 300;
const MIN_REMAINING_SECS = 30;

const enc = (s: string) => new TextEncoder().encode(s);

/** Demo address of Stellar account `account` (a valid `G…` strkey; not the SEP-0005 key). */
export function demoStellarAddress(seed: Uint8Array, account: number): string {
  return stellarAddressOfKey(sha256(new Uint8Array([...seed, ...enc(`kyro-demo-stellar-${account}`)])));
}

const invalidInput = (m: string) => new IpcError('INVALID_INPUT', `Entrée invalide : ${m}`);

/** `12,5 XLM`: stroops with French decimals, trailing zeros removed. */
export function demoXlmText(stroops: bigint | string): string {
  const v = BigInt(stroops);
  const frac = (v % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
  return `${v / 10_000_000n}${frac ? `,${frac}` : ''} XLM`;
}

/** wallet-core `stellar_account_id`: same messages. */
export function checkStellarAddress(a: unknown): string {
  const s = String(a ?? '').trim();
  switch (stellarAddressKind(s)) {
    case 'account':
      return s;
    case 'muxed':
      throw invalidInput("les adresses M… (comptes multiplexés) ne sont pas prises en charge : demande l'adresse G… et le mémo");
    case 'secret':
      throw invalidInput('ceci est une CLÉ SECRÈTE Stellar (S…), pas une adresse : ne la donne jamais à personne');
    default:
      throw invalidInput('adresse Stellar invalide (G… attendue)');
  }
}

interface DemoStellarAccount {
  balance: bigint;
  sequence: bigint;
  subentries: number;
  memoRequired: boolean;
}

/** Demo envelope (base64 JSON). */
interface DemoEnvelope {
  source: string;
  fee: string;
  sequence: string;
  minTime: number;
  maxTime: number;
  memo: StellarMemoView;
  operation: StellarOpView;
  signature?: string;
}

export interface DemoStellarDeps {
  network: Network;
  seed: Uint8Array;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
  now: () => number;
}

export interface DemoStellarState {
  me: string;
  /** An exchange deposit account that requires a memo (SEP-0029). */
  exchange: string;
  /** A funded account without any requirement. */
  friend: string;
  accounts: Map<string, DemoStellarAccount>;
  history: StellarHistoryEntry[];
  submitted: Set<string>;
}

/** commands_stellar.rs parse_memo, same messages. */
export function demoParseMemo(m: StellarMemoSpec | undefined): StellarMemoView {
  if (!m) return { kind: 'none' };
  const v = String(m.value ?? '');
  switch (m.kind) {
    case 'text': {
      if (v === '') return { kind: 'none' };
      const bytes = enc(v);
      if (bytes.length > 28) throw invalidInput('mémo texte : 28 octets au plus');
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁯﻿]/.test(v)) throw invalidInput('mémo texte : caractère de contrôle ou invisible refusé');
      return { kind: 'text', text: v, hex: bytesToHex(bytes) };
    }
    case 'id': {
      const t = v.trim();
      if (!/^\d{1,20}$/.test(t)) throw invalidInput('mémo identifiant : un nombre entier positif');
      if (BigInt(t) > 0xffffffffffffffffn) throw invalidInput('mémo identifiant : au plus 18446744073709551615');
      return { kind: 'id', id: BigInt(t).toString() };
    }
    case 'hash': {
      const t = v.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(t)) throw invalidInput('mémo hash : 64 caractères hexadécimaux');
      return { kind: 'hash', hex: t };
    }
    default:
      throw invalidInput('type de mémo inconnu');
  }
}

export function createDemoStellar(d: DemoStellarDeps) {
  const netKey = d.network === 'mainnet' ? 'mainnet' : 'testnet';
  const me = demoStellarAddress(d.seed, 0);
  const label = (l: string) => stellarAddressOfKey(sha256(enc(l)));
  const exchange = label('kyro-demo-stellar-exchange');
  const friend = label('kyro-demo-stellar-friend');
  const t0 = d.now();
  const state: DemoStellarState = {
    me,
    exchange,
    friend,
    accounts: new Map([
      // One trustline: reserve (2 + 1) × 0.5 = 1.5 XLM.
      [me, { balance: 1_250_000_000n, sequence: 4_294_967_296n * 51n + 3n, subentries: 1, memoRequired: false }],
      [exchange, { balance: 98_000_000_000_000n, sequence: 9_000_000n, subentries: 0, memoRequired: true }],
      [friend, { balance: 3_100_000_000n, sequence: 77n, subentries: 0, memoRequired: false }],
    ]),
    history: [
      {
        id: '1',
        hash: bytesToHex(sha256(enc('xlm-in-2'))),
        type: 'payment',
        from: exchange,
        to: me,
        amount: { kind: 'native', stroops: '500000000' },
        fee: '100',
        time: t0 - 86_400_000,
        successful: true,
        memo: { kind: 'none' },
        txSource: exchange,
      },
      {
        id: '0',
        hash: bytesToHex(sha256(enc('xlm-in-1'))),
        type: 'create_account',
        from: friend,
        to: me,
        amount: { kind: 'native', stroops: '750000000' },
        fee: '100',
        time: t0 - 4 * 86_400_000,
        successful: true,
        memo: { kind: 'text', text: 'bienvenue' },
        txSource: friend,
      },
    ],
    submitted: new Set(),
  };

  const torOn = () => d.settings().tor.enabled;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ledgerTime = () => Math.floor(d.now() / 5000) * 5;

  const backend = async () => {
    if (torOn()) await d.tor.waitReady();
    await wait(50 + Math.random() * 120);
  };

  const account = (address: string): StellarAccountInfo => {
    const a = state.accounts.get(address);
    const base = { address, numSponsoring: 0, numSponsored: 0, sellingLiabilities: '0', trustlines: [], baseReserve: STELLAR_BASE_RESERVE.toString() };
    if (!a) return { ...base, exists: false, balance: '0', sequence: '0', subentryCount: 0, reserve: '0', spendable: '0', memoRequired: false };
    const reserve = BigInt(2 + a.subentries) * STELLAR_BASE_RESERVE;
    return {
      ...base,
      exists: true,
      balance: a.balance.toString(),
      sequence: a.sequence.toString(),
      subentryCount: a.subentries,
      reserve: reserve.toString(),
      spendable: (a.balance > reserve ? a.balance - reserve : 0n).toString(),
      memoRequired: a.memoRequired,
    };
  };

  /** stellar_backend::check_payment, same order and messages. */
  const checkPayment = (ours: StellarAccountInfo, dest: StellarAccountInfo, stroops: bigint, fee: bigint, hasMemo: boolean) => {
    if (!ours.exists) throw invalidInput('ton compte Stellar n’est pas encore activé : il doit d’abord recevoir au moins 1 XLM');
    if (stroops <= 0n) throw invalidInput('montant nul');
    if (dest.memoRequired && !hasMemo) {
      throw invalidInput('ce destinataire exige un mémo (SEP-0029, souvent une plateforme d’échange) : ajoute-le, sinon les fonds risquent d’être perdus');
    }
    const minCreate = 2n * STELLAR_BASE_RESERVE;
    if (!dest.exists && stroops < minCreate) {
      throw invalidInput(`ce compte n’existe pas encore : il faut lui envoyer au moins ${demoXlmText(minCreate)} (2 × la réserve de base) pour le créer`);
    }
    const spendable = BigInt(ours.spendable);
    if (stroops + fee > spendable) {
      throw invalidInput(`solde disponible insuffisant : ${demoXlmText(spendable)} disponibles (solde − réserve), il en faut ${demoXlmText(stroops + fee).replace(' XLM', '')}`);
    }
  };

  const encode = (e: DemoEnvelope) => base64.encode(enc(JSON.stringify(e)));
  const hashOf = (env: string) => bytesToHex(sha256(enc(`stellar:${netKey}:${env}`)));

  /** wallet-core stellar_decode_tx: strict, source = us, time bounds mandatory, one operation. */
  const decode = (envelope: unknown): { e: DemoEnvelope; summary: StellarTxSummary } => {
    let e: DemoEnvelope;
    try {
      e = JSON.parse(new TextDecoder().decode(base64.decode(String(envelope ?? '').trim()))) as DemoEnvelope;
    } catch {
      throw invalidInput('transaction Stellar : base64 invalide');
    }
    if (e.source !== me) throw invalidInput("transaction Stellar : la source n'est pas l'adresse de ce portefeuille");
    if (!e.maxTime) throw invalidInput('transaction Stellar : aucune limite de temps : la transaction resterait valable indéfiniment');
    const op = e.operation;
    if (op.kind !== 'changeTrust') {
      checkStellarAddress(op.destination);
      if (op.destination === me) throw invalidInput('transaction Stellar : paiement à soi-même');
    }
    const summary: StellarTxSummary = { network: d.network, source: e.source, fee: e.fee, sequence: e.sequence, minTime: e.minTime, maxTime: e.maxTime, memo: e.memo, operation: op, warnings: [], requiresExtraConfirmation: false };
    if (BigInt(e.fee) > 100_000n) {
      summary.warnings.push({ kind: 'highFee' });
      summary.requiresExtraConfirmation = true;
    }
    return { e, summary };
  };

  const amountOf = (op: StellarOpView): bigint => (op.kind === 'payment' ? BigInt(op.amount) : op.kind === 'createAccount' ? BigInt(op.startingBalance) : 0n);
  const contextFor = (to: string): StellarContext => ({ account: account(me), destination: account(to), baseReserve: STELLAR_BASE_RESERVE.toString(), baseFee: Number(BASE_FEE), ledgerTime: ledgerTime() });

  const memoLine = (m: StellarMemoView) => {
    switch (m.kind) {
      case 'none':
        return "AUCUN MÉMO\n(une plateforme d'échange en exige souvent un : sans lui, les fonds peuvent être perdus)\n";
      case 'text':
        return m.text !== null ? `MÉMO (texte) : « ${m.text} »\n` : `MÉMO (texte non lisible, octets) : ${m.hex}\n`;
      case 'id':
        return `MÉMO (identifiant) : ${m.id}\n`;
      case 'hash':
        return `MÉMO (hash) : ${m.hex}\n`;
      case 'return':
        return `MÉMO (remboursement) : ${m.hex}\n`;
    }
  };

  /** commands_stellar.rs describe_stellar (main lines). */
  const describe = (s: StellarTxSummary, c: StellarContext): string => {
    const line = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    const op = s.operation;
    if (op.kind === 'changeTrust') return 'Ligne de confiance Stellar';
    let out = `Envoi Stellar${op.kind === 'createAccount' ? ' — création de compte' : ''}${d.network === 'testnet' ? ' (testnet)' : ''}\n\nÀ : ${op.destination}\n${line}\n${memoLine(s.memo)}${line}\n`;
    const amount = amountOf(op);
    out += `Montant : ${demoXlmText(amount)} (${amount} stroops)\n`;
    if (op.kind === 'createAccount') out += `\nCe compte n'existe pas encore : cet envoi le crée (opération CreateAccount). ${demoXlmText(2n * STELLAR_BASE_RESERVE)} de réserve y reste bloqué (2 × ${demoXlmText(STELLAR_BASE_RESERVE)}).\n`;
    out += `\nFrais maximum : ${demoXlmText(s.fee)} (${s.fee} stroops ; d'habitude seuls ${c.baseFee} stroops sont prélevés)\n`;
    out += `Solde : ${demoXlmText(c.account.balance)} · réserve bloquée : ${demoXlmText(c.account.reserve)} ((2 + ${c.account.subentryCount} entrée(s)) × ${demoXlmText(c.baseReserve)}) · disponible : ${demoXlmText(c.account.spendable)}\n`;
    out += `Valable ≈ ${Math.ceil((s.maxTime - c.ledgerTime) / 60)} min, séquence ${s.sequence}\n`;
    out += `Réseau signé : « ${d.network === 'mainnet' ? 'Public Global Stellar Network ; September 2015' : 'Test SDF Network ; September 2015'} »\n`;
    return out;
  };

  const handlers: Record<Extract<keyof Commands, `stellar_${string}`>, (a: Record<string, unknown>) => unknown> = {
    stellar_backend_info: (): StellarBackendInfo => ({ kind: 'default', network: netKey, label: d.network === 'mainnet' ? 'horizon.stellar.org' : 'horizon-testnet.stellar.org', tor: torOn() }),
    stellar_address: (a) => {
      d.requireUnlocked();
      const n = a.account === undefined ? 0 : Number(a.account);
      if (!Number.isInteger(n) || n < 0 || n > 100) throw invalidInput('numéro de compte : au plus 100');
      return demoStellarAddress(d.seed, n);
    },
    stellar_account: async (a) => {
      const addr = checkStellarAddress(a.address);
      await backend();
      return account(addr);
    },
    stellar_txs: async (a) => {
      const addr = checkStellarAddress(a.address);
      await backend();
      return state.history.filter((t) => t.from === addr || t.to === addr).slice(0, 50);
    },
    stellar_build_tx: async (a) => {
      d.requireUnlocked();
      const to = checkStellarAddress(a.to);
      const amountStr = String(a.amount ?? '').trim();
      if (!/^\d+$/.test(amountStr) || BigInt(amountStr) <= 0n) throw invalidInput('montant en stroops invalide');
      const memo = demoParseMemo(a.memo as StellarMemoSpec | undefined);
      await backend();
      const context = contextFor(to);
      checkPayment(context.account, context.destination, BigInt(amountStr), BASE_FEE, memo.kind !== 'none');
      const operation: StellarOpView = context.destination.exists
        ? { kind: 'payment', destination: to, asset: { kind: 'native' }, amount: amountStr }
        : { kind: 'createAccount', destination: to, startingBalance: amountStr };
      const e: DemoEnvelope = { source: me, fee: BASE_FEE.toString(), sequence: (BigInt(context.account.sequence) + 1n).toString(), minTime: 0, maxTime: context.ledgerTime + VALIDITY_SECS, memo, operation };
      const envelope = encode(e);
      return { envelope, summary: decode(envelope).summary, context };
    },
    stellar_sign_tx: async (a) => {
      d.requireUnlocked();
      const { e, summary } = decode(a.envelope);
      const op = summary.operation;
      if (op.kind === 'changeTrust' || (op.kind === 'payment' && op.asset.kind !== 'native')) throw invalidInput("Kyro ne signe que des envois de XLM pour l'instant");
      await backend();
      const context = contextFor(op.destination);
      if (summary.maxTime <= context.ledgerTime + MIN_REMAINING_SECS) throw invalidInput('transaction Stellar expirée (limite de temps presque atteinte) : reconstruis-la');
      if (summary.sequence !== (BigInt(context.account.sequence) + 1n).toString()) throw invalidInput('numéro de séquence périmé : reconstruis la transaction');
      if ((op.kind === 'createAccount') === context.destination.exists) {
        throw invalidInput(op.kind === 'createAccount' ? 'ce compte existe maintenant : reconstruis la transaction (paiement simple)' : 'ce compte n’existe pas : reconstruis la transaction (création de compte)');
      }
      checkPayment(context.account, context.destination, amountOf(op), BigInt(summary.fee), summary.memo.kind !== 'none');
      d.checkPassword(a.password);
      if (!d.confirm(`Confirmer l'envoi Stellar\n${describe(summary, context)}`)) throw new IpcError('USER_REJECTED', 'Signature refusée.');
      if (summary.requiresExtraConfirmation && !d.confirm('Attention : transaction à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?')) throw new IpcError('USER_REJECTED', 'Signature refusée.');
      const signed = encode({ ...e, signature: bytesToHex(sha256(enc(`sig:${String(a.envelope)}`))) });
      return { envelope: signed, hash: hashOf(signed), summary, context };
    },
    stellar_broadcast: async (a) => {
      const { e, summary } = decode(a.envelope);
      if (!e.signature) throw invalidInput('transaction Stellar : une signature attendue');
      await backend();
      await wait(300);
      const hash = hashOf(String(a.envelope).trim());
      const ours = state.accounts.get(me);
      const op = summary.operation;
      if (op.kind === 'changeTrust') throw invalidInput('transaction Stellar refusée : refusée par le réseau');
      if (!ours || summary.sequence !== (ours.sequence + 1n).toString()) throw invalidInput('transaction Stellar refusée : numéro de séquence périmé : reconstruis la transaction (tx_bad_seq)');
      if (summary.maxTime < ledgerTime()) throw invalidInput('transaction Stellar refusée : transaction expirée (limite de temps dépassée) : reconstruis-la (tx_too_late)');
      const amount = amountOf(op);
      const spendable = BigInt(account(me).spendable);
      if (amount + BigInt(summary.fee) > spendable) throw invalidInput('transaction Stellar refusée : solde disponible insuffisant (tx_failed / op_underfunded)');
      // Charged: the base fee (no surge pricing in the demo), not the maximum.
      ours.balance -= BASE_FEE + amount;
      ours.sequence += 1n;
      const dest = state.accounts.get(op.destination);
      if (dest) dest.balance += amount;
      else state.accounts.set(op.destination, { balance: amount, sequence: 0n, subentries: 0, memoRequired: false });
      state.submitted.add(hash);
      const memo: StellarHistoryEntry['memo'] =
        summary.memo.kind === 'text' ? { kind: 'text', text: summary.memo.text ?? '' } : summary.memo.kind === 'id' ? { kind: 'id', id: summary.memo.id } : summary.memo.kind === 'hash' ? { kind: 'hash', value: summary.memo.hex } : { kind: 'none' };
      state.history.unshift({ id: String(state.history.length), hash, type: op.kind === 'createAccount' ? 'create_account' : 'payment', from: me, to: op.destination, amount: { kind: 'native', stroops: amount.toString() }, fee: BASE_FEE.toString(), time: d.now(), successful: true, memo, txSource: me });
      return hash;
    },
    stellar_tx_status: async (a) => {
      const h = String(a.hash ?? '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(h)) throw invalidInput('hash : 64 caractères hexadécimaux');
      await backend();
      const found = state.submitted.has(h);
      return { found, successful: found };
    },
  };

  return { state, handlers };
}
