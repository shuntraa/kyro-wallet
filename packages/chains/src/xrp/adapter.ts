// SPDX-License-Identifier: GPL-3.0-or-later
//
// XRP Ledger adapter (XRP + issued currencies). Thin on purpose: reads, Payment building
// (Sequence / Fee / LastLedgerSequence filled by Rust, encoded by wallet-core), signature and
// `submit` are Rust commands (`xrp_*`, docs/IPC.md §2.6). This adapter only validates input and
// checks that what Rust built is what was asked (destination, amount, **destination tag**).

import { call } from '@kyro/shared';
import type { XrpChain } from '../registry';
import type { HistoryItem } from '../types';

// ---------------------------------------------------------------- Rust contract (§2.6)

export interface XrpAccountInfo {
  address: string;
  /** Activated (funded with at least the base reserve). */
  exists: boolean;
  /** Drops (1 XRP = 1 000 000 drops), decimal strings. */
  balance: string;
  sequence: number;
  ownerCount: number;
  flags: number;
  /** The account refuses payments without a destination tag: make the tag field mandatory. */
  requireDestTag: boolean;
  disallowXrp: boolean;
  /** Locked: base reserve + owner reserve × owned objects (drops). */
  reserve: string;
  /** Balance − reserve (drops). */
  spendable: string;
}

export type XrpAmountView = { kind: 'xrp'; drops: string } | { kind: 'issued'; value: string; currency: string; issuer: string };

export type XrpWarning = { kind: 'sendMax' } | { kind: 'pathFlags' } | { kind: 'memo' } | { kind: 'highFee' } | { kind: 'invoiceId' };

export interface XrpTxSummary {
  account: string;
  destination: string;
  /** null = no tag. Show it prominently. */
  destinationTag: number | null;
  amount: XrpAmountView;
  fee: string;
  sequence: number;
  lastLedgerSequence: number | null;
  flags: number;
  sendMax: XrpAmountView | null;
  sourceTag: number | null;
  invoiceId: string | null;
  memos: Array<{ memoType: string | null; memoData: string | null; memoFormat: string | null; text: string | null }>;
  warnings: XrpWarning[];
  requiresExtraConfirmation: boolean;
}

export interface XrpContext {
  account: XrpAccountInfo;
  destination: XrpAccountInfo;
  reserveBase: string;
  reserveInc: string;
}

export interface XrpHistoryEntry {
  hash: string;
  from: string;
  to: string;
  destinationTag: number | null;
  /** Delivered amount (not `Amount`: partial payments deliver less). */
  amount: XrpAmountView | null;
  fee: string;
  ledger: number | null;
  time: number | null;
  result: string;
}

export interface XrpIssued {
  currency: string;
  issuer: string;
}

export interface XrpBackend {
  account(address: string): Promise<XrpAccountInfo>;
  lines(address: string): Promise<Array<{ currency: string; issuer: string; balance: string; limit: string }>>;
  txs(address: string): Promise<XrpHistoryEntry[]>;
  build(to: string, amount: string, destinationTag?: number, issued?: XrpIssued): Promise<{ blob: string; summary: XrpTxSummary; context: XrpContext }>;
  sign(blob: string, password: string): Promise<{ blob: string; hash: string; summary: XrpTxSummary; context: XrpContext }>;
  broadcast(blob: string): Promise<string>;
  txStatus(hash: string): Promise<{ validated: boolean; result: string }>;
}

/** `xrp_*` are not (yet) in `@kyro/shared`'s typed `Commands`: untyped view of `call`, typed here. */
type RawCall = <R>(cmd: string, args?: Record<string, unknown>) => Promise<R>;
const rawCall = call as unknown as RawCall;

export function rustXrpBackend(invoke: RawCall = rawCall): XrpBackend {
  return {
    account: (address) => invoke('xrp_account', { address }),
    lines: (address) => invoke('xrp_lines', { address }),
    txs: (address) => invoke('xrp_txs', { address }),
    build: (to, amount, destinationTag, issued) =>
      invoke('xrp_build_tx', { to, amount, ...(destinationTag !== undefined ? { destinationTag } : {}), ...(issued ? { issued } : {}) }),
    sign: (blob, password) => invoke('xrp_sign_tx', { blob, password }),
    broadcast: (blob) => invoke('xrp_broadcast', { blob }),
    txStatus: (hash) => invoke('xrp_tx_status', { hash }),
  };
}

// ---------------------------------------------------------------- addresses and tags

const RIPPLE_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

/**
 * Classic `r…` address shape (Ripple base58 alphabet, 25–35 characters). The checksum is
 * verified by Rust (`xrp_account_id`) on every command; X-addresses are refused.
 */
export function isXrpAddress(address: string): boolean {
  const a = address.trim();
  return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a) && [...a].every((c) => RIPPLE_ALPHABET.includes(c));
}

/** Destination tag: an integer 0 … 4 294 967 295, or empty. */
export function parseDestinationTag(input: string): number | undefined {
  const s = input.trim();
  if (s === '') return undefined;
  if (!/^\d{1,10}$/.test(s)) throw new Error('Tag de destination invalide (nombre entier)');
  const n = Number(s);
  if (n > 0xffffffff) throw new Error('Tag de destination trop grand (max. 4 294 967 295)');
  return n;
}

// ---------------------------------------------------------------- adapter

export interface XrpUnsigned {
  family: 'xrp';
  blob: string;
  summary: XrpTxSummary;
  context: XrpContext;
  recipient: string;
  amount: string;
  destinationTag?: number;
}

export interface XrpSigned {
  family: 'xrp';
  blob: string;
  hash: string;
  summary: XrpTxSummary;
}

export interface XrpAdapterOptions {
  chain: XrpChain;
  address: string;
  backend?: XrpBackend;
}

export class XrpAdapter {
  readonly family = 'xrp' as const;
  readonly chain: XrpChain;
  private readonly address: string;
  private readonly backend: XrpBackend;

  constructor(opts: XrpAdapterOptions) {
    if (!isXrpAddress(opts.address)) throw new Error('Adresse XRP invalide');
    this.chain = opts.chain;
    this.address = opts.address;
    this.backend = opts.backend ?? rustXrpBackend();
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return isXrpAddress(address);
  }

  account(): Promise<XrpAccountInfo> {
    return this.backend.account(this.address);
  }

  /** Destination facts the Send screen needs before building: exists? tag required? */
  destinationInfo(address: string): Promise<XrpAccountInfo> {
    return this.backend.account(address);
  }

  /** XRP balance, plus `spendable` = balance − reserve (what can actually be sent). */
  async getBalance(): Promise<Array<{ assetId: string; amount: bigint; spendable: bigint }>> {
    const acc = await this.backend.account(this.address);
    return [{ assetId: 'xrp', amount: BigInt(acc.balance), spendable: BigInt(acc.spendable) }];
  }

  /** Issued-currency balances (trust lines); values are decimal strings (≤ 16 significant digits). */
  trustLines(): Promise<Array<{ currency: string; issuer: string; balance: string; limit: string }>> {
    return this.backend.lines(this.address);
  }

  /** `amount`: drops (XRP) or decimal value (issued). Rust re-checks reserve, tag and balance. */
  async buildTx(params: { to: string; amount: string; destinationTag?: number; issued?: XrpIssued }): Promise<XrpUnsigned> {
    const to = params.to.trim();
    if (!isXrpAddress(to)) throw new Error('Adresse XRP invalide (adresse classique r… attendue)');
    if (to === this.address) throw new Error('Paiement à soi-même impossible');
    if (!params.issued && !/^\d+$/.test(params.amount)) throw new Error('Montant en drops invalide');
    const built = await this.backend.build(to, params.amount, params.destinationTag, params.issued);
    const s = built.summary;
    const amountOk = params.issued
      ? s.amount.kind === 'issued' && s.amount.currency === params.issued.currency && s.amount.issuer === params.issued.issuer
      : s.amount.kind === 'xrp' && s.amount.drops === params.amount;
    const tagOk = (s.destinationTag ?? undefined) === params.destinationTag;
    if (!amountOk || !tagOk || s.destination !== to || s.account !== this.address || s.requiresExtraConfirmation) {
      throw new Error('Le paiement construit par Rust ne correspond pas à la demande');
    }
    return { family: 'xrp', blob: built.blob, summary: s, context: built.context, recipient: to, amount: params.amount, ...(params.destinationTag !== undefined ? { destinationTag: params.destinationTag } : {}) };
  }

  /** Rust: live checks, native dialog (tag highlighted, reserve), signature. */
  async signTx(unsigned: XrpUnsigned, password: string): Promise<XrpSigned> {
    const res = await this.backend.sign(unsigned.blob, password);
    if (!/^[0-9A-F]{64}$/i.test(res.hash)) throw new Error('Hash XRP inattendu');
    return { family: 'xrp', blob: res.blob, hash: res.hash, summary: res.summary };
  }

  /** Rust verifies the signature and that the server's hash is ours. */
  async broadcast(signed: XrpSigned): Promise<string> {
    const hash = await this.backend.broadcast(signed.blob);
    if (hash.toUpperCase() !== signed.hash.toUpperCase()) throw new Error('Hash diffusé inattendu');
    return hash;
  }

  txStatus(hash: string): Promise<{ validated: boolean; result: string }> {
    return this.backend.txStatus(hash);
  }

  async getHistory(): Promise<HistoryItem[]> {
    const list = await this.backend.txs(this.address);
    return list.map((t) => {
      const out = t.from === this.address;
      const item: HistoryItem = {
        id: t.hash,
        chainKey: this.chain.key,
        assetId: t.amount?.kind === 'issued' ? `xrpl:${t.amount.currency}:${t.amount.issuer}` : 'xrp',
        direction: out ? 'out' : 'in',
        amount: t.amount?.kind === 'xrp' ? BigInt(t.amount.drops) : 0n,
        status: t.result === 'tesSUCCESS' ? 'confirmed' : 'failed',
        kind: 'transfer',
      };
      if (out) item.fee = BigInt(t.fee || '0');
      const counterparty = out ? t.to : t.from;
      if (counterparty) item.counterparty = counterparty;
      if (t.time) item.time = t.time;
      return item;
    });
  }
}
