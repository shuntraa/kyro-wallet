// SPDX-License-Identifier: GPL-3.0-or-later
//
// XRP Ledger adapter (XRP + issued currencies). Thin on purpose: reads, Payment building
// (Sequence / Fee / LastLedgerSequence filled by Rust, encoded by wallet-core), signature and
// `submit` are Rust commands (`xrp_*`, docs/IPC.md §2.6). This adapter only validates input and
// checks that what Rust built is what was asked (destination, amount, **destination tag**).

import { accountArg } from '../types';
import {
  call,
  type XrpAccountInfo,
  type XrpAmountView,
  type XrpContext,
  type XrpHistoryEntry,
  type XrpTrustLine,
  type XrpTxSummary,
  type XrpWarning, l10n } from '@kyro/shared';
import type { XrpChain } from '../registry';
import type { HwSigner } from '../hw';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';

// ---------------------------------------------------------------- Rust contract (§2.6)

export type { XrpAccountInfo, XrpAmountView, XrpContext, XrpHistoryEntry, XrpTrustLine, XrpTxSummary, XrpWarning };

export interface XrpIssued {
  currency: string;
  issuer: string;
}

export interface XrpBackend {
  account(address: string): Promise<XrpAccountInfo>;
  lines(address: string): Promise<XrpTrustLine[]>;
  txs(address: string): Promise<XrpHistoryEntry[]>;
  build(to: string, amount: string, destinationTag?: number, issued?: XrpIssued): Promise<{ blob: string; summary: XrpTxSummary; context: XrpContext }>;
  sign(blob: string, password: string): Promise<{ blob: string; hash: string; summary: XrpTxSummary; context: XrpContext }>;
  broadcast(blob: string): Promise<string>;
  txStatus(hash: string): Promise<{ validated: boolean; result: string }>;
}

/** The typed `xrp_*` commands of `@kyro/shared` (docs/IPC.md §2.6), for vault account `account`. */
export function rustXrpBackend(account = 0): XrpBackend {
  const acct = accountArg(account);
  return {
    account: (address) => call('xrp_account', { address }),
    lines: (address) => call('xrp_lines', { address }),
    txs: (address) => call('xrp_txs', { address }),
    build: (to, amount, destinationTag, issued) => call('xrp_build_tx', { to, amount, ...(destinationTag !== undefined ? { destinationTag } : {}), ...(issued ? { issued } : {}), ...acct }),
    sign: (blob, password) => call('xrp_sign_tx', { blob, password, ...acct }),
    broadcast: (blob) => call('xrp_broadcast', { blob, ...acct }),
    txStatus: (hash) => call('xrp_tx_status', { hash }),
  };
}

/**
 * Hardware-wallet account `accountId` (docs/IPC.md §2.3): Rust builds and broadcasts with the
 * account's stored key (`hw_xrp_build_tx`, `hw_xrp_broadcast`); signing is `hw_sign_xrp_tx`.
 */
export function hwXrpBackend(accountId: string): XrpBackend {
  const reads = rustXrpBackend(0);
  return {
    ...reads,
    build: (to, amount, destinationTag, issued) => call('hw_xrp_build_tx', { accountId, to, amount, ...(destinationTag !== undefined ? { destinationTag } : {}), ...(issued ? { issued } : {}) }),
    sign: () => Promise.reject(new Error(l10n('Compte hardware wallet : signature sur l’appareil', 'Hardware-wallet account: sign on the device'))),
    broadcast: (blob) => call('hw_xrp_broadcast', { accountId, blob }),
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

/**
 * X-address (`X…` mainnet / `T…` testnet, destination tag embedded): Rust refuses them
 * (wallet-core `xrp_account_id`, same rule). The UI asks for the classic address + tag instead.
 */
export function isXAddress(address: string): boolean {
  const a = address.trim();
  return (a.startsWith('X') || a.startsWith('T')) && a.length >= 46 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(a);
}

/** Destination tag: an integer 0 … 4 294 967 295, or empty. */
export function parseDestinationTag(input: string): number | undefined {
  const s = input.trim();
  if (s === '') return undefined;
  if (!/^\d{1,10}$/.test(s)) throw new Error(l10n('Tag de destination invalide (nombre entier)', 'Invalid destination tag (whole number)'));
  const n = Number(s);
  if (n > 0xffffffff) throw new Error(l10n('Tag de destination trop grand (max. 4 294 967 295)', 'Destination tag too large (max. 4,294,967,295)'));
  return n;
}

// ---------------------------------------------------------------- adapter

export interface XrpUnsigned {
  family: 'xrp';
  blob: string;
  summary: XrpTxSummary;
  context: XrpContext;
  recipient: string;
  /** Drops (XRP). 0n for an issued currency (its value is `drops`/`summary.amount`). */
  amount: bigint;
  /** What was asked: drops (XRP) or the decimal value (issued). */
  drops: string;
  destinationTag?: number;
  /** Fee set by Rust (drops): the whole cost on top of the amount. */
  maxFee: bigint;
  size: { family: 'xrp' };
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
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
  /** Hardware-wallet account (signing through `hw_sign_xrp_tx`, Ledger only). */
  hw?: HwSigner;
}

export class XrpAdapter implements ChainAdapter<'xrp'> {
  readonly family = 'xrp' as const;
  readonly chain: XrpChain;
  private readonly address: string;
  private readonly backend: XrpBackend;
  readonly hw: HwSigner | null;

  constructor(opts: XrpAdapterOptions) {
    if (!isXrpAddress(opts.address)) throw new Error(l10n('Adresse XRP invalide', 'Invalid XRP address'));
    this.chain = opts.chain;
    this.address = opts.address;
    this.hw = opts.hw ?? null;
    this.backend = opts.backend ?? (opts.hw ? hwXrpBackend(opts.hw.accountId) : rustXrpBackend(opts.account ?? 0));
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
  async getBalance(): Promise<Array<Balance & { spendable: bigint }>> {
    const acc = await this.backend.account(this.address);
    return [{ assetId: 'xrp', amount: BigInt(acc.balance), spendable: BigInt(acc.spendable) }];
  }

  /** Issued-currency balances (trust lines); values are decimal strings (≤ 16 significant digits). */
  trustLines(): Promise<XrpTrustLine[]> {
    return this.backend.lines(this.address);
  }

  /** No fee to choose: Rust sets `Fee` from the open ledger (usually 10–12 drops). */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'xrp' as const };
    const eta = this.chain.blockTimeSecs;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: l10n('frais fixés par le registre (≈ 0,000012 XRP)', 'fees set by the ledger (≈ 0.000012 XRP)'),
      fetchedAt: Date.now(),
    });
  }

  /**
   * `ChainAdapter` entry point (XRP only; issued currencies go through `buildPayment`). `max`:
   * spendable (balance − reserve) minus the fee Rust sets, built twice.
   */
  async buildTx(params: BuildParams): Promise<XrpUnsigned> {
    if (params.asset.kind !== 'native') throw new Error(l10n('Actif XRP Ledger inattendu', 'Unexpected XRP Ledger asset'));
    const tag = params.destinationTag !== undefined ? { destinationTag: params.destinationTag } : {};
    if (!params.max) return this.buildPayment({ to: params.to, amount: params.amount.toString(), ...tag });
    const spendable = BigInt((await this.backend.account(this.address)).spendable);
    // First pass with a fee ceiling of 0.001 XRP; then exactly spendable − fee.
    const first = await this.buildPayment({ to: params.to, amount: (spendable - 1_000n).toString(), ...tag }).catch(() => null);
    const fee = first ? BigInt(first.summary.fee) : 12n;
    const amount = spendable - fee;
    if (amount <= 0n) throw new Error(l10n('Rien à envoyer : tout ton solde est bloqué par la réserve', 'Nothing to send: your whole balance is locked by the reserve'));
    return this.buildPayment({ to: params.to, amount: amount.toString(), ...tag });
  }

  /** `amount`: drops (XRP) or decimal value (issued). Rust re-checks reserve, tag and balance. */
  async buildPayment(params: { to: string; amount: string; destinationTag?: number; issued?: XrpIssued }): Promise<XrpUnsigned> {
    const to = params.to.trim();
    if (!isXrpAddress(to)) throw new Error(l10n('Adresse XRP invalide (adresse classique r… attendue)', 'Invalid XRP address (classic r… address expected)'));
    if (to === this.address) throw new Error(l10n('Paiement à soi-même impossible', 'Cannot pay yourself'));
    if (!params.issued && !/^\d+$/.test(params.amount)) throw new Error(l10n('Montant en drops invalide', 'Invalid amount in drops'));
    const built = await this.backend.build(to, params.amount, params.destinationTag, params.issued);
    const s = built.summary;
    const amountOk = params.issued
      ? s.amount.kind === 'issued' && s.amount.currency === params.issued.currency && s.amount.issuer === params.issued.issuer
      : s.amount.kind === 'xrp' && s.amount.drops === params.amount;
    const tagOk = (s.destinationTag ?? undefined) === params.destinationTag;
    if (!amountOk || !tagOk || s.destination !== to || s.account !== this.address || s.requiresExtraConfirmation) {
      throw new Error(l10n('Le paiement construit par Rust ne correspond pas à la demande', 'The payment built by Rust does not match the request'));
    }
    return {
      family: 'xrp',
      blob: built.blob,
      summary: s,
      context: built.context,
      recipient: to,
      amount: params.issued ? 0n : BigInt(params.amount),
      drops: params.amount,
      ...(params.destinationTag !== undefined ? { destinationTag: params.destinationTag } : {}),
      maxFee: BigInt(s.fee),
      size: { family: 'xrp' },
    };
  }

  /** Rust: live checks, native dialog (tag highlighted, reserve), signature. */
  async signTx(unsigned: XrpUnsigned, password: string): Promise<XrpSigned> {
    const res = await this.backend.sign(unsigned.blob, password);
    if (!/^[0-9A-F]{64}$/i.test(res.hash)) throw new Error('Hash XRP inattendu');
    return { family: 'xrp', blob: res.blob, hash: res.hash, summary: res.summary };
  }

  /** Hardware wallet: Rust's checks and dialog, then the device; the signature is verified in Rust. */
  async signTxHw(unsigned: XrpUnsigned, deviceId: string): Promise<XrpSigned> {
    if (!this.hw) throw new Error(l10n('Ce compte n’est pas un hardware wallet', 'This account is not a hardware wallet'));
    const res = await call('hw_sign_xrp_tx', { id: deviceId, accountId: this.hw.accountId, blob: unsigned.blob });
    if (!/^[0-9A-F]{64}$/i.test(res.hash)) throw new Error('Hash XRP inattendu');
    return { family: 'xrp', blob: res.blob, hash: res.hash, summary: res.summary };
  }

  /** Rust verifies the signature and that the server's hash is ours. */
  async broadcast(signed: XrpSigned): Promise<string> {
    const hash = await this.backend.broadcast(signed.blob);
    if (hash.toUpperCase() !== signed.hash.toUpperCase()) throw new Error(l10n('Hash diffusé inattendu', 'Unexpected broadcast hash'));
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
