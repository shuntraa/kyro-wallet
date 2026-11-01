// SPDX-License-Identifier: GPL-3.0-or-later
//
// Algorand adapter (ALGO payments). Thin on purpose: reads, payment building (fee, validity
// window and genesis filled by Rust, canonical msgpack encoded by wallet-core), signature and
// submission are Rust commands (`algo_*`, docs/IPC.md §2.11). This adapter only validates input
// and checks that what Rust built is what was asked (receiver, amount, note).

import {
  call,
  isAlgoAddress,
  type AlgoAccountInfo,
  type AlgoBuilt,
  type AlgoContext,
  type AlgoHistoryEntry,
  type AlgoTxStatus,
  type AlgoTxSummary,
  type AlgoWarning,
} from '@kyro/shared';
import { accountArg } from '../types';
import type { AlgorandChain } from '../registry';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';

export type { AlgoAccountInfo, AlgoContext, AlgoHistoryEntry, AlgoTxStatus, AlgoTxSummary, AlgoWarning };

/** 0.1 ALGO: minimum balance of an account (each asset opted in adds 0.1 ALGO). */
export const ALGO_MIN_BALANCE = 100_000n;
/** Protocol maximum note size, bytes. */
export const ALGO_MAX_NOTE = 1024;

export interface AlgoBackend {
  account(address: string): Promise<AlgoAccountInfo>;
  txs(address: string): Promise<AlgoHistoryEntry[]>;
  build(to: string, amount: string, note?: string): Promise<AlgoBuilt>;
  sign(blob: string, password: string): Promise<{ blob: string; txid: string; summary: AlgoTxSummary; context: AlgoContext }>;
  broadcast(blob: string): Promise<string>;
  txStatus(txid: string): Promise<AlgoTxStatus>;
}

/** The typed `algo_*` commands of `@kyro/shared` (docs/IPC.md §2.11), for vault account `account`. */
export function rustAlgoBackend(account = 0): AlgoBackend {
  const acct = accountArg(account);
  return {
    account: (address) => call('algo_account', { address }),
    txs: (address) => call('algo_txs', { address }),
    build: (to, amount, note) => call('algo_build_tx', { to, amount, ...(note ? { note } : {}), ...acct }),
    sign: (blob, password) => call('algo_sign_tx', { blob, password, ...acct }),
    broadcast: (blob) => call('algo_broadcast', { blob, ...acct }),
    txStatus: (txid) => call('algo_tx_status', { txid }),
  };
}

/**
 * Algorand address: 58 upper-case base32 characters = public key ‖ last 4 bytes of
 * SHA-512/256(key) (`@kyro/shared`). Checked here for the UI; Rust checks again on every command.
 */
export { isAlgoAddress };

/** Size of a note in bytes (UTF-8), what the 1024-byte limit counts. */
export function algoNoteBytes(note: string): number {
  return new TextEncoder().encode(note).length;
}

export interface AlgoUnsigned {
  family: 'algo';
  blob: string;
  summary: AlgoTxSummary;
  context: AlgoContext;
  recipient: string;
  /** µALGO. */
  amount: bigint;
  note?: string;
  /** Fee set by Rust (µALGO): the whole cost on top of the amount. */
  maxFee: bigint;
  size: { family: 'algo' };
}

export interface AlgoSigned {
  family: 'algo';
  blob: string;
  txid: string;
  summary: AlgoTxSummary;
}

export interface AlgorandAdapterOptions {
  chain: AlgorandChain;
  address: string;
  backend?: AlgoBackend;
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
}

export class AlgorandAdapter implements ChainAdapter<'algo'> {
  readonly family = 'algo' as const;
  readonly chain: AlgorandChain;
  private readonly address: string;
  private readonly backend: AlgoBackend;

  constructor(opts: AlgorandAdapterOptions) {
    if (!isAlgoAddress(opts.address)) throw new Error('Adresse Algorand invalide');
    this.chain = opts.chain;
    this.address = opts.address;
    this.backend = opts.backend ?? rustAlgoBackend(opts.account ?? 0);
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return isAlgoAddress(address);
  }

  account(): Promise<AlgoAccountInfo> {
    return this.backend.account(this.address);
  }

  /** Receiver facts the Send screen needs before building: does it exist (≥ 0.1 ALGO needed)? */
  destinationInfo(address: string): Promise<AlgoAccountInfo> {
    return this.backend.account(address);
  }

  /** ALGO balance, plus `spendable` = balance − minimum balance (what can actually be sent). */
  async getBalance(): Promise<Array<Balance & { spendable: bigint }>> {
    const acc = await this.backend.account(this.address);
    return [{ assetId: 'algo', amount: BigInt(acc.balance), spendable: BigInt(acc.spendable) }];
  }

  /** No fee to choose: Rust sets the protocol minimum (0.001 ALGO), more only under congestion. */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'algo' as const };
    const eta = this.chain.blockTimeSecs;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: 'frais fixés par le protocole (0,001 ALGO)',
      fetchedAt: Date.now(),
    });
  }

  /** `ChainAdapter` entry point. `max`: spendable (balance − minimum balance) minus the fee Rust sets. */
  async buildTx(params: BuildParams): Promise<AlgoUnsigned> {
    if (params.asset.kind !== 'native') throw new Error('Actif Algorand inattendu');
    const note = params.memo?.trim() ? { note: params.memo } : {};
    if (!params.max) return this.buildPayment({ to: params.to, amount: params.amount.toString(), ...note });
    const spendable = BigInt((await this.backend.account(this.address)).spendable);
    const first = await this.buildPayment({ to: params.to, amount: (spendable - 10_000n).toString(), ...note }).catch(() => null);
    const fee = first ? BigInt(first.summary.fee) : 1_000n;
    const amount = spendable - fee;
    if (amount <= 0n) throw new Error('Rien à envoyer : tout ton solde est bloqué par le solde minimum');
    return this.buildPayment({ to: params.to, amount: amount.toString(), ...note });
  }

  /** `amount`: µALGO. Rust re-checks both minimum balances and the spendable amount. */
  async buildPayment(params: { to: string; amount: string; note?: string }): Promise<AlgoUnsigned> {
    const to = params.to.trim();
    if (!isAlgoAddress(to)) throw new Error('Adresse Algorand invalide (58 caractères A–Z, 2–7)');
    if (to === this.address) throw new Error('Paiement à soi-même impossible');
    if (!/^\d+$/.test(params.amount) || BigInt(params.amount) <= 0n) throw new Error('Montant en µALGO invalide');
    const note = params.note ?? '';
    if (algoNoteBytes(note) > ALGO_MAX_NOTE) throw new Error('Note trop longue (1024 octets au plus)');
    const built = await this.backend.build(to, params.amount, note || undefined);
    const s = built.summary;
    const noteOk = note ? s.noteLen === algoNoteBytes(note) && s.noteText === note : s.noteLen === 0;
    const extraOk = s.warnings.every((w) => w.kind === 'note' && note !== '');
    if (s.receiver !== to || s.sender !== this.address || s.amount !== params.amount || !noteOk || !extraOk) {
      throw new Error('Le paiement construit par Rust ne correspond pas à la demande');
    }
    return {
      family: 'algo',
      blob: built.blob,
      summary: s,
      context: built.context,
      recipient: to,
      amount: BigInt(params.amount),
      ...(note ? { note } : {}),
      maxFee: BigInt(s.fee),
      size: { family: 'algo' },
    };
  }

  /** Rust: live checks, native dialog (amount, receiver, note, fee, genesis), signature. */
  async signTx(unsigned: AlgoUnsigned, password: string): Promise<AlgoSigned> {
    const res = await this.backend.sign(unsigned.blob, password);
    if (!/^[A-Z2-7]{52}$/.test(res.txid) || res.txid !== unsigned.summary.txid) throw new Error('Identifiant de transaction Algorand inattendu');
    return { family: 'algo', blob: res.blob, txid: res.txid, summary: res.summary };
  }

  /** Rust verifies the signature and that algod's id is ours. */
  async broadcast(signed: AlgoSigned): Promise<string> {
    const txid = await this.backend.broadcast(signed.blob);
    if (txid !== signed.txid) throw new Error('Identifiant diffusé inattendu');
    return txid;
  }

  txStatus(txid: string): Promise<AlgoTxStatus> {
    return this.backend.txStatus(txid);
  }

  async getHistory(): Promise<HistoryItem[]> {
    const list = await this.backend.txs(this.address);
    return list.map((t) => {
      const out = t.from === this.address;
      const self = out && t.to === this.address;
      const item: HistoryItem = {
        id: t.id,
        chainKey: this.chain.key,
        assetId: 'algo',
        direction: self ? 'self' : out ? 'out' : 'in',
        amount: BigInt(t.amount || '0') + (t.closeTo === this.address || (out && t.closeTo) ? BigInt(t.closeAmount ?? '0') : 0n),
        status: t.round ? 'confirmed' : 'pending',
        kind: t.type === 'pay' ? 'transfer' : 'contract',
      };
      if (out) item.fee = BigInt(t.fee || '0');
      const counterparty = out ? t.to : t.from;
      if (counterparty) item.counterparty = counterparty;
      if (t.time) item.time = t.time;
      if (t.note) item.note = t.note;
      else if (t.type !== 'pay') item.note = `Transaction ${t.type} (non gérée par Kyro)`;
      return item;
    });
  }
}
