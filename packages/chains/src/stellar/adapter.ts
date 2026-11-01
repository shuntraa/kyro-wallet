// SPDX-License-Identifier: GPL-3.0-or-later
//
// Stellar adapter (XLM). Thin on purpose: reads, transaction building (sequence / fee / time
// bounds filled by Rust, XDR encoded by wallet-core; CreateAccount when the destination does not
// exist yet), signature and submission are Rust commands (`stellar_*`, docs/IPC.md §2.11). This
// adapter only validates input and checks that what Rust built is what was asked (destination,
// amount, **memo**).

import {
  call,
  isStellarAddress,
  stellarAddressKind,
  type StellarAccountInfo,
  type StellarContext,
  type StellarHistoryEntry,
  type StellarMemoSpec,
  type StellarMemoView,
  type StellarOpView,
  type StellarTxSummary,
  type StellarWarning,
} from '@kyro/shared';
import { accountArg } from '../types';
import type { StellarChain } from '../registry';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';

// ---------------------------------------------------------------- Rust contract (§2.11)

export type { StellarAccountInfo, StellarContext, StellarHistoryEntry, StellarMemoSpec, StellarMemoView, StellarOpView, StellarTxSummary, StellarWarning };

export interface StellarBackend {
  account(address: string): Promise<StellarAccountInfo>;
  txs(address: string): Promise<StellarHistoryEntry[]>;
  build(to: string, amount: string, memo?: StellarMemoSpec): Promise<{ envelope: string; summary: StellarTxSummary; context: StellarContext }>;
  sign(envelope: string, password: string): Promise<{ envelope: string; hash: string; summary: StellarTxSummary; context: StellarContext }>;
  broadcast(envelope: string): Promise<string>;
  txStatus(hash: string): Promise<{ found: boolean; successful: boolean }>;
}

/** The typed `stellar_*` commands of `@kyro/shared` (docs/IPC.md §2.11), for vault account `account`. */
export function rustStellarBackend(account = 0): StellarBackend {
  const acct = accountArg(account);
  return {
    account: (address) => call('stellar_account', { address }),
    txs: (address) => call('stellar_txs', { address }),
    build: (to, amount, memo) => call('stellar_build_tx', { to, amount, ...(memo ? { memo } : {}), ...acct }),
    sign: (envelope, password) => call('stellar_sign_tx', { envelope, password, ...acct }),
    broadcast: (envelope) => call('stellar_broadcast', { envelope, ...acct }),
    txStatus: (hash) => call('stellar_tx_status', { hash }),
  };
}

// ---------------------------------------------------------------- addresses, amounts, memos

export { isStellarAddress, stellarAddressKind };

/** Why a pasted recipient is refused, in French, or null when it is a valid `G…` address. */
export function stellarAddressProblem(address: string): string | null {
  switch (stellarAddressKind(address)) {
    case 'account':
      return null;
    case 'muxed':
      return 'Adresse M… (compte multiplexé) non prise en charge : demande l’adresse G… et le mémo.';
    case 'secret':
      return 'Ceci est une CLÉ SECRÈTE Stellar (S…), pas une adresse : ne la donne jamais à personne.';
    default:
      return 'Adresse Stellar invalide (G…, 56 caractères).';
  }
}

/** `12,5` / `12.5` XLM → stroops (7 decimals at most). */
export function xlmToStroops(input: string): bigint {
  const s = input.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,7})?$/.test(s)) throw new Error('Montant XLM invalide (7 décimales au plus)');
  const [int = '0', frac = ''] = s.split('.');
  return BigInt(int) * 10_000_000n + BigInt(frac.padEnd(7, '0'));
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/**
 * Memo typed by the user: empty → none; `kind` chosen in the UI. Same rules as Rust's
 * `parse_memo` (text ≤ 28 bytes without control / invisible character, id = u64, hash = 64 hex).
 */
export function parseStellarMemo(kind: StellarMemoSpec['kind'], value: string): StellarMemoSpec | undefined {
  if (kind === 'text') {
    if (value === '') return undefined;
    if (utf8Length(value) > 28) throw new Error('Mémo texte trop long (28 octets au plus)');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁯﻿]/.test(value)) throw new Error('Mémo texte : caractère de contrôle ou invisible refusé');
    return { kind, value };
  }
  const v = value.trim();
  if (v === '') return undefined;
  if (kind === 'id') {
    if (!/^\d{1,20}$/.test(v) || BigInt(v) > 0xffffffffffffffffn) throw new Error('Mémo identifiant invalide (nombre entier, 18446744073709551615 au plus)');
    return { kind, value: BigInt(v).toString() };
  }
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new Error('Mémo hash invalide (64 caractères hexadécimaux)');
  return { kind, value: v.toLowerCase() };
}

/** Does Rust's decoded memo match what was asked? */
export function sameMemo(asked: StellarMemoSpec | undefined, got: StellarMemoView): boolean {
  if (!asked) return got.kind === 'none';
  switch (asked.kind) {
    case 'text':
      return got.kind === 'text' && got.text === asked.value;
    case 'id':
      return got.kind === 'id' && got.id === asked.value;
    case 'hash':
      return got.kind === 'hash' && got.hex === asked.value;
  }
}

/** One line for the interface (history, review). */
export function stellarMemoText(m: StellarMemoView | StellarHistoryEntry['memo']): string | null {
  switch (m.kind) {
    case 'none':
      return null;
    case 'text':
      return m.text === null ? `mémo (octets) ${'hex' in m ? m.hex : ''}` : `mémo « ${m.text} »`;
    case 'id':
      return `mémo ${m.id}`;
    case 'hash':
      return `mémo hash ${'hex' in m ? m.hex : m.value}`;
    case 'return':
      return `mémo remboursement ${'hex' in m ? m.hex : m.value}`;
  }
}

// ---------------------------------------------------------------- adapter

export interface StellarUnsigned {
  family: 'xlm';
  envelope: string;
  summary: StellarTxSummary;
  context: StellarContext;
  recipient: string;
  /** Stroops. */
  amount: bigint;
  memo?: StellarMemoSpec;
  /** CreateAccount: the destination did not exist, this transfer creates it. */
  createsAccount: boolean;
  /** Maximum fee set by Rust (stroops). Usually only the base fee (100) is charged. */
  maxFee: bigint;
  size: { family: 'xlm' };
}

export interface StellarSigned {
  family: 'xlm';
  envelope: string;
  hash: string;
  summary: StellarTxSummary;
}

export interface StellarAdapterOptions {
  chain: StellarChain;
  address: string;
  backend?: StellarBackend;
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
}

const amountOf = (op: StellarOpView): string | null => (op.kind === 'payment' && op.asset.kind === 'native' ? op.amount : op.kind === 'createAccount' ? op.startingBalance : null);

export class StellarAdapter implements ChainAdapter<'xlm'> {
  readonly family = 'xlm' as const;
  readonly chain: StellarChain;
  private readonly address: string;
  private readonly backend: StellarBackend;

  constructor(opts: StellarAdapterOptions) {
    if (!isStellarAddress(opts.address)) throw new Error('Adresse Stellar invalide');
    this.chain = opts.chain;
    this.address = opts.address;
    this.backend = opts.backend ?? rustStellarBackend(opts.account ?? 0);
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return isStellarAddress(address);
  }

  account(): Promise<StellarAccountInfo> {
    return this.backend.account(this.address);
  }

  /** Destination facts the Send screen needs before building: exists? memo required? */
  destinationInfo(address: string): Promise<StellarAccountInfo> {
    return this.backend.account(address);
  }

  /** XLM balance, plus `spendable` = balance − reserve (what can actually be sent). */
  async getBalance(): Promise<Array<Balance & { spendable: bigint }>> {
    const acc = await this.backend.account(this.address);
    return [{ assetId: 'xlm', amount: BigInt(acc.balance), spendable: BigInt(acc.spendable) }];
  }

  /** No fee to choose: Rust bids from Horizon's fee stats (≤ 0.01 XLM); usually 100 stroops are charged. */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'xlm' as const };
    const eta = this.chain.blockTimeSecs;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: 'frais fixés par le réseau (d’habitude 0,00001 XLM)',
      fetchedAt: Date.now(),
    });
  }

  /** `ChainAdapter` entry point. `max`: spendable (balance − reserve) minus the fee Rust bids, built twice. */
  async buildTx(params: BuildParams): Promise<StellarUnsigned> {
    if (params.asset.kind !== 'native') throw new Error('Actif Stellar inattendu (XLM seulement)');
    const memo = params.stellarMemo;
    if (!params.max) return this.buildPayment({ to: params.to, stroops: params.amount, ...(memo ? { memo } : {}) });
    const spendable = BigInt((await this.backend.account(this.address)).spendable);
    const first = await this.buildPayment({ to: params.to, stroops: spendable - 100_000n, ...(memo ? { memo } : {}) }).catch(() => null);
    const fee = first ? BigInt(first.summary.fee) : 100n;
    const amount = spendable - fee;
    if (amount <= 0n) throw new Error('Rien à envoyer : tout ton solde est bloqué par la réserve');
    return this.buildPayment({ to: params.to, stroops: amount, ...(memo ? { memo } : {}) });
  }

  /** Rust re-checks reserve, memo requirement, existence and balance. */
  async buildPayment(params: { to: string; stroops: bigint; memo?: StellarMemoSpec }): Promise<StellarUnsigned> {
    const to = params.to.trim();
    const problem = stellarAddressProblem(to);
    if (problem) throw new Error(problem);
    if (to === this.address) throw new Error('Envoi à soi-même impossible');
    if (params.stroops <= 0n) throw new Error('Montant nul');
    const built = await this.backend.build(to, params.stroops.toString(), params.memo);
    const s = built.summary;
    const op = s.operation;
    const dest = op.kind === 'changeTrust' ? null : op.destination;
    if (dest !== to || amountOf(op) !== params.stroops.toString() || !sameMemo(params.memo, s.memo) || s.source !== this.address || s.network !== this.chain.network || s.requiresExtraConfirmation) {
      throw new Error('La transaction construite par Rust ne correspond pas à la demande');
    }
    return {
      family: 'xlm',
      envelope: built.envelope,
      summary: s,
      context: built.context,
      recipient: to,
      amount: params.stroops,
      ...(params.memo ? { memo: params.memo } : {}),
      createsAccount: op.kind === 'createAccount',
      maxFee: BigInt(s.fee),
      size: { family: 'xlm' },
    };
  }

  /** Rust: live checks, native dialog (memo framed, reserve), signature. */
  async signTx(unsigned: StellarUnsigned, password: string): Promise<StellarSigned> {
    const res = await this.backend.sign(unsigned.envelope, password);
    if (!/^[0-9a-f]{64}$/i.test(res.hash)) throw new Error('Hash Stellar inattendu');
    return { family: 'xlm', envelope: res.envelope, hash: res.hash, summary: res.summary };
  }

  /** Rust verifies the signature for this network and that Horizon's hash is ours. */
  async broadcast(signed: StellarSigned): Promise<string> {
    const hash = await this.backend.broadcast(signed.envelope);
    if (hash.toLowerCase() !== signed.hash.toLowerCase()) throw new Error('Hash diffusé inattendu');
    return hash;
  }

  txStatus(hash: string): Promise<{ found: boolean; successful: boolean }> {
    return this.backend.txStatus(hash);
  }

  async getHistory(): Promise<HistoryItem[]> {
    const list = await this.backend.txs(this.address);
    return list.map((t) => {
      const out = t.from === this.address;
      const self = out && t.to === this.address;
      const item: HistoryItem = {
        id: t.id ? `${t.hash}:${t.id}` : t.hash,
        chainKey: this.chain.key,
        assetId: t.amount.kind === 'credit' ? `xlm:${t.amount.code}:${t.amount.issuer}` : 'xlm',
        direction: self ? 'self' : out ? 'out' : 'in',
        amount: t.amount.stroops ? BigInt(t.amount.stroops) : 0n,
        status: t.successful ? 'confirmed' : 'failed',
        kind: 'transfer',
      };
      // The fee is paid by the transaction's source (us when we signed it).
      if (t.txSource === this.address && t.fee) item.fee = BigInt(t.fee);
      const counterparty = out ? t.to : t.from;
      if (counterparty && !self) item.counterparty = counterparty;
      if (t.time) item.time = t.time;
      const notes = [t.type === 'create_account' ? (out ? 'création du compte destinataire' : 'création de ton compte') : null, stellarMemoText(t.memo)].filter(Boolean);
      if (notes.length) item.note = notes.join(' · ');
      // Shown as outgoing although we did not sign it (poisoning lure).
      if (out && t.txSource !== this.address) item.suspect = 'notSigned';
      if (item.amount === 0n && t.amount.kind === 'native') item.suspect = 'zero';
      return item;
    });
  }
}
