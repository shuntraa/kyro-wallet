// SPDX-License-Identifier: GPL-3.0-or-later
//
// TON adapter (Toncoin, wallet v4R2). Thin on purpose: reads, transfer building (seqno and
// account states read by Rust, cells written by wallet-core, fee emulated by TON Center),
// signature and broadcast are Rust commands (`ton_*`, docs/IPC.md §2.11). This adapter only
// validates input and checks that what Rust built is what was asked (recipient, amount,
// **comment**).

import { accountArg } from '../types';
import {
  call,
  l10n,
  parseTonAddress,
  sameTonAccount,
  tonAddressProblem,
  type TonAccountInfo,
  type TonContext,
  type TonHistoryEntry,
  type TonTxStatus,
  type TonTxSummary,
  type TonWarning,
} from '@kyro/shared';
import type { TonChain } from '../registry';
import type { HwSigner } from '../hw';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';

export type { TonAccountInfo, TonContext, TonHistoryEntry, TonTxStatus, TonTxSummary, TonWarning };

/** Longest comment Rust accepts (one cell after the text opcode). */
export const TON_MAX_COMMENT_BYTES = 123;

export interface TonBackend {
  account(address: string): Promise<TonAccountInfo>;
  txs(address: string): Promise<TonHistoryEntry[]>;
  build(to: string, amount: string, comment?: string, sendAll?: boolean): Promise<{ boc: string; summary: TonTxSummary; context: TonContext }>;
  sign(boc: string, password: string): Promise<{ boc: string; hash: string; normalizedHash: string; summary: TonTxSummary; context: TonContext }>;
  broadcast(boc: string): Promise<string>;
  txStatus(hash: string): Promise<TonTxStatus>;
}

/** The typed `ton_*` commands of `@kyro/shared` (docs/IPC.md §2.11), for vault account `account`. */
export function rustTonBackend(account = 0): TonBackend {
  const acct = accountArg(account);
  return {
    account: (address) => call('ton_account', { address }),
    txs: (address) => call('ton_txs', { address }),
    build: (to, amount, comment, sendAll) => call('ton_build_tx', { to, amount, ...(comment ? { comment } : {}), ...(sendAll ? { sendAll } : {}), ...acct }),
    sign: (boc, password) => call('ton_sign_tx', { boc, password, ...acct }),
    broadcast: (boc) => call('ton_broadcast', { boc, ...acct }),
    txStatus: (hash) => call('ton_tx_status', { hash }),
  };
}

/**
 * Ledger account `accountId` (docs/IPC.md §2.3): build and broadcast for its own v4R2 wallet,
 * signature on the device (`hw_*` commands). `sign`'s second argument is the device id, not a
 * password. Status: the generic `ton_tx_status`.
 */
export function rustTonHwBackend(accountId: string): TonBackend {
  return {
    ...rustTonBackend(),
    build: (to, amount, comment, sendAll) => call('hw_ton_build_tx', { accountId, to, amount, ...(comment ? { comment } : {}), ...(sendAll ? { sendAll } : {}) }),
    sign: (boc, id) => call('hw_sign_ton_tx', { id, accountId, boc }),
    broadcast: (boc) => call('hw_ton_broadcast', { accountId, boc }),
  };
}

/** Longest comment the Ledger TON app shows (printable ASCII only). */
export const TON_HW_MAX_COMMENT = 120;

/** Why the Ledger TON app cannot show `comment`, or null (Rust checks the same). */
export function tonHwCommentProblem(comment: string): string | null {
  if (comment.length > TON_HW_MAX_COMMENT || !/^[ -~]*$/.test(comment)) {
    return l10n('Commentaire sur Ledger : 120 caractères ASCII imprimables au plus (pas d’accents ni d’emoji)', 'Comment on a Ledger: at most 120 printable ASCII characters (no accents or emoji)');
  }
  return null;
}

// ---------------------------------------------------------------- addresses and comments

/**
 * Why `address` cannot receive TON from Kyro on `network`, or null: user-friendly form only
 * (checksum verified), basechain only, testnet-only addresses refused on mainnet. Rust checks
 * the same on every command.
 */
export function tonRecipientProblem(address: string, network: 'mainnet' | 'testnet'): string | null {
  const problem = tonAddressProblem(address);
  if (problem) return problem;
  const p = parseTonAddress(address);
  if (!p) return l10n('adresse TON invalide', 'invalid TON address');
  if (p.workchain !== 0) return l10n('adresse de la masterchain (-1) : seuls les comptes de la basechain (0) sont pris en charge', 'masterchain address (-1): only basechain (0) accounts are supported');
  if (p.testnet && network === 'mainnet') return l10n('adresse TON de testnet (kQ… / 0Q…) : refusée sur mainnet', 'testnet TON address (kQ… / 0Q…): refused on mainnet');
  return null;
}

export function isTonAddress(address: string): boolean {
  return tonAddressProblem(address) === null;
}

/** Why a comment is refused, or null. Empty = no comment. */
export function tonCommentProblem(comment: string): string | null {
  const bytes = new TextEncoder().encode(comment).length;
  if (bytes > TON_MAX_COMMENT_BYTES) return l10n(`Commentaire trop long (${bytes} octets, ${TON_MAX_COMMENT_BYTES} au plus)`, `Comment too long (${bytes} bytes, ${TON_MAX_COMMENT_BYTES} at most)`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁯﻿]/.test(comment)) {
    return l10n('Commentaire : caractères de contrôle ou invisibles refusés', 'Comment: control or invisible characters refused');
  }
  return null;
}

// ---------------------------------------------------------------- adapter

const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);

export interface TonUnsigned {
  family: 'ton';
  /** Unsigned external message (BOC base64), decoded again by Rust before signing. */
  boc: string;
  summary: TonTxSummary;
  context: TonContext;
  recipient: string;
  /** Nanotons. With `sendAll`: balance − estimated fee (display only, Rust sends everything). */
  amount: bigint;
  comment?: string;
  sendAll: boolean;
  /** Fee estimated by emulation (nanotons): paid on top of the amount. */
  maxFee: bigint;
  size: { family: 'ton' };
}

export interface TonSigned {
  family: 'ton';
  boc: string;
  hash: string;
  normalizedHash: string;
  summary: TonTxSummary;
}

export interface TonAdapterOptions {
  chain: TonChain;
  address: string;
  backend?: TonBackend;
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
  /** Hardware-wallet account (Ledger): signing through `hw_sign_*` (`signTxHw`). */
  hw?: HwSigner;
}

export class TonAdapter implements ChainAdapter<'ton'> {
  readonly family = 'ton' as const;
  readonly chain: TonChain;
  private readonly address: string;
  private readonly backend: TonBackend;
  readonly hw: HwSigner | null;

  constructor(opts: TonAdapterOptions) {
    if (!isTonAddress(opts.address)) throw new Error(l10n('Adresse TON invalide', 'Invalid TON address'));
    this.chain = opts.chain;
    this.address = opts.address;
    this.hw = opts.hw ?? null;
    this.backend = opts.backend ?? (opts.hw ? rustTonHwBackend(opts.hw.accountId) : rustTonBackend(opts.account ?? 0));
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return tonRecipientProblem(address, this.chain.network) === null;
  }

  account(): Promise<TonAccountInfo> {
    return this.backend.account(this.address);
  }

  /** Recipient facts the Send screen shows before building: active? never used? */
  destinationInfo(address: string): Promise<TonAccountInfo> {
    return this.backend.account(address);
  }

  async getBalance(): Promise<Balance[]> {
    const acc = await this.backend.account(this.address);
    return [{ assetId: 'ton', amount: BigInt(acc.balance) }];
  }

  /** No fee to choose: the network's price, estimated by emulation when building. */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'ton' as const };
    const eta = this.chain.blockTimeSecs;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: l10n('frais fixés par le réseau (≈ 0,003 à 0,01 TON, estimés à la préparation)', 'fees set by the network (≈ 0.003 to 0.01 TON, estimated when preparing)'),
      fetchedAt: Date.now(),
    });
  }

  /** `max`: the whole balance (mode 130: Rust's message carries everything, minus fees). */
  async buildTx(params: BuildParams): Promise<TonUnsigned> {
    if (params.asset.kind !== 'native') throw new Error(l10n('Actif TON inattendu', 'Unexpected TON asset'));
    const to = params.to.trim();
    const problem = tonRecipientProblem(to, this.chain.network);
    if (problem) throw new Error(problem.charAt(0).toUpperCase() + problem.slice(1));
    if (sameTonAccount(to, this.address)) throw new Error(l10n('Envoi à soi-même impossible', 'Cannot send to yourself'));
    const comment = params.memo ?? '';
    const cp = tonCommentProblem(comment) ?? (this.hw ? tonHwCommentProblem(comment) : null);
    if (cp) throw new Error(cp);
    const sendAll = params.max === true;
    if (!sendAll && params.amount <= 0n) throw new Error(l10n('Montant invalide', 'Invalid amount'));
    const built = await this.backend.build(to, sendAll ? '0' : params.amount.toString(), comment || undefined, sendAll);
    const s = built.summary;
    const amountOk = sendAll ? s.sendAll && s.amount === '0' : !s.sendAll && s.amount === params.amount.toString();
    const commentOk = (s.comment ?? '') === comment;
    if (!amountOk || !commentOk || !sameTonAccount(s.destination, to) || !sameTonAccount(s.wallet, this.address) || s.requiresExtraConfirmation) {
      throw new Error(l10n('Le transfert construit par Rust ne correspond pas à la demande', 'The transfer built by Rust does not match the request'));
    }
    return {
      family: 'ton',
      boc: built.boc,
      summary: s,
      context: built.context,
      recipient: to,
      // Whole balance: what should arrive (balance − estimated fee), for display only; Rust's
      // message carries « everything » (mode 130), not this number.
      amount: sendAll ? maxBig(0n, BigInt(built.context.account.balance) - BigInt(built.context.fee)) : params.amount,
      ...(comment ? { comment } : {}),
      sendAll,
      maxFee: BigInt(built.context.fee),
      size: { family: 'ton' },
    };
  }

  /** Ledger: same checks as `signTx`; Rust re-reads the key, shows its dialog, then the device signs. */
  signTxHw(unsigned: TonUnsigned, deviceId: string): Promise<TonSigned> {
    if (!this.hw) return Promise.reject(new Error(l10n('Ce compte n’est pas un hardware wallet', 'This account is not a hardware wallet')));
    return this.signTx(unsigned, deviceId);
  }

  /** Rust: live checks, native dialog (comment framed, both address forms), signature. */
  async signTx(unsigned: TonUnsigned, password: string): Promise<TonSigned> {
    const res = await this.backend.sign(unsigned.boc, password);
    if (!/^[0-9a-f]{64}$/.test(res.hash) || !/^[0-9a-f]{64}$/.test(res.normalizedHash)) throw new Error(l10n('Hash TON inattendu', 'Unexpected TON hash'));
    return { family: 'ton', boc: res.boc, hash: res.hash, normalizedHash: res.normalizedHash, summary: res.summary };
  }

  /** Rust verifies the signature and that TON Center's hashes are ours. Returns the normalized hash. */
  async broadcast(signed: TonSigned): Promise<string> {
    const id = await this.backend.broadcast(signed.boc);
    if (id !== signed.normalizedHash) throw new Error(l10n('Hash diffusé inattendu', 'Unexpected broadcast hash'));
    return id;
  }

  txStatus(hash: string): Promise<TonTxStatus> {
    return this.backend.txStatus(hash);
  }

  async getHistory(): Promise<HistoryItem[]> {
    const list = await this.backend.txs(this.address);
    return list.map((t, i) => {
      const item: HistoryItem = {
        // One transaction can carry several outgoing messages: keep ids unique.
        id: list.findIndex((o) => o.hash === t.hash) === i ? t.hash : `${t.hash}:${i}`,
        chainKey: this.chain.key,
        assetId: 'ton',
        direction: t.direction,
        amount: BigInt(t.amount),
        status: t.success ? 'confirmed' : 'failed',
        kind: 'transfer',
      };
      if (t.fee) item.fee = BigInt(t.fee);
      if (t.counterparty) item.counterparty = t.counterparty;
      if (t.time) item.time = t.time;
      const notes = [t.bounced ? l10n('retour d’un envoi qui a échoué (rebond)', 'return of a failed send (bounce)') : null, t.comment ? l10n(`Commentaire : ${t.comment}`, `Comment: ${t.comment}`) : null].filter((x): x is string => !!x);
      if (notes.length) item.note = notes.join(' · ');
      return item;
    });
  }
}
