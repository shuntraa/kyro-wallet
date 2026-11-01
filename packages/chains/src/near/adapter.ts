// SPDX-License-Identifier: GPL-3.0-or-later
//
// NEAR Protocol adapter (NEAR only, no NEP-141 token yet). Thin on purpose: reads, transfer
// building (nonce and block hash filled by Rust, Borsh encoded by wallet-core), signature and
// `send_tx` are Rust commands (`near_*`, docs/IPC.md §2.11). This adapter only validates input
// and checks that what Rust built is what was asked (receiver, amount, signer).

import { accountArg } from '../types';
import {
  call,
  l10n,
  nearAccountIdProblem,
  nearAccountKind,
  type NearAccountInfo,
  type NearAccountKind,
  type NearContext,
  type NearHistoryEntry,
  type NearTxOutcome,
  type NearTxSummary,
  type NearWarning,
} from '@kyro/shared';
import type { NearChain } from '../registry';
import type { HwSigner } from '../hw';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';

export type { NearAccountInfo, NearAccountKind, NearContext, NearHistoryEntry, NearTxOutcome, NearTxSummary, NearWarning };
export { nearAccountKind, nearAccountIdProblem };

// ---------------------------------------------------------------- Rust contract (§2.11)

export interface NearBackend {
  account(accountId: string): Promise<NearAccountInfo>;
  txs(accountId: string): Promise<NearHistoryEntry[]>;
  build(to: string, amount: string): Promise<{ tx: string; summary: NearTxSummary; context: NearContext }>;
  sign(tx: string, password: string): Promise<{ signed: string; hash: string; summary: NearTxSummary; context: NearContext }>;
  broadcast(signed: string): Promise<NearTxOutcome>;
  txStatus(hash: string): Promise<NearTxOutcome>;
}

/** The typed `near_*` commands of `@kyro/shared` (docs/IPC.md §2.11), for vault account `account`. */
export function rustNearBackend(account = 0): NearBackend {
  const acct = accountArg(account);
  return {
    account: (accountId) => call('near_account', { accountId }),
    txs: (accountId) => call('near_txs', { accountId }),
    build: (to, amount) => call('near_build_tx', { to, amount, ...acct }),
    sign: (tx, password) => call('near_sign_tx', { tx, password, ...acct }),
    broadcast: (signed) => call('near_broadcast', { signed, ...acct }),
    txStatus: (hash) => call('near_tx_status', { hash, ...acct }),
  };
}

/**
 * Ledger account `accountId` (docs/IPC.md §2.3): build and broadcast for its address, signature
 * on the device (`hw_*` commands). `sign`'s second argument is the device id, not a password.
 */
export function rustNearHwBackend(accountId: string): NearBackend {
  return {
    ...rustNearBackend(),
    build: (to, amount) => call('hw_near_build_tx', { accountId, to, amount }),
    sign: (tx, id) => call('hw_sign_near_tx', { id, accountId, tx }),
    broadcast: (signed) => call('hw_near_broadcast', { accountId, signed }),
    txStatus: (hash) => call('hw_near_tx_status', { accountId, hash }),
  };
}

/** Our own address: an implicit account (64 lowercase hex). */
export function isNearImplicit(id: string): boolean {
  return nearAccountKind(id) === 'implicit';
}

// ---------------------------------------------------------------- adapter

export interface NearUnsigned {
  family: 'near';
  /** Borsh hex built by Rust. */
  tx: string;
  summary: NearTxSummary;
  context: NearContext;
  recipient: string;
  /** yoctoNEAR. */
  amount: bigint;
  /** Kyro's fee bound (yoctoNEAR): fees are not written in a NEAR transaction. */
  maxFee: bigint;
  size: { family: 'near' };
}

export interface NearSigned {
  family: 'near';
  signed: string;
  hash: string;
  summary: NearTxSummary;
}

export interface NearAdapterOptions {
  chain: NearChain;
  address: string;
  backend?: NearBackend;
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
  /** Hardware-wallet account (Ledger): signing through `hw_sign_*` (`signTxHw`). */
  hw?: HwSigner;
}

export class NearAdapter implements ChainAdapter<'near'> {
  readonly family = 'near' as const;
  readonly chain: NearChain;
  private readonly address: string;
  readonly hw: HwSigner | null;
  private readonly backend: NearBackend;

  constructor(opts: NearAdapterOptions) {
    if (!isNearImplicit(opts.address)) throw new Error(l10n('Compte NEAR implicite invalide', 'Invalid NEAR implicit account'));
    this.chain = opts.chain;
    this.address = opts.address;
    this.hw = opts.hw ?? null;
    this.backend = opts.backend ?? (opts.hw ? rustNearHwBackend(opts.hw.accountId) : rustNearBackend(opts.account ?? 0));
  }

  getAddress(): string {
    return this.address;
  }

  /** Any valid account id (implicit, named, `0x…`). Existence is checked by Rust. */
  isValidAddress(address: string): boolean {
    return nearAccountKind(address.trim()) !== null;
  }

  account(): Promise<NearAccountInfo> {
    return this.backend.account(this.address);
  }

  /** Receiver facts the Send screen shows before building: exists? kind? */
  receiverInfo(accountId: string): Promise<NearAccountInfo> {
    return this.backend.account(accountId.trim());
  }

  /** NEAR balance, plus `spendable` = balance − storage reserve. */
  async getBalance(): Promise<Array<Balance & { spendable: bigint }>> {
    const acc = await this.backend.account(this.address);
    return [{ assetId: 'near', amount: BigInt(acc.balance), spendable: BigInt(acc.spendable) }];
  }

  /** No fee to choose: charged at the block's gas price (≈ 0,00005 NEAR for a transfer). */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'near' as const };
    const eta = this.chain.blockTimeSecs * 2;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: l10n('frais au prix du gas du bloc (≈ 0,00005 NEAR, borne vérifiée par Kyro)', 'fee at the block gas price (≈ 0.00005 NEAR, bound checked by Kyro)'),
      fetchedAt: Date.now(),
    });
  }

  /** `max`: spendable minus Kyro's fee bound (first build to learn it, then exactly). */
  async buildTx(params: BuildParams): Promise<NearUnsigned> {
    if (params.asset.kind !== 'native') throw new Error(l10n('Actif NEAR inattendu', 'Unexpected NEAR asset'));
    if (!params.max) return this.buildTransfer(params.to, params.amount);
    const spendable = BigInt((await this.backend.account(this.address)).spendable);
    // A first pass with a generous bound (0.02 NEAR), then spendable − Rust's bound.
    const first = await this.buildTransfer(params.to, spendable - 20_000_000_000_000_000_000_000n).catch(() => null);
    if (!first) throw new Error(l10n('Rien à envoyer : solde insuffisant une fois la réserve de stockage et les frais déduits', 'Nothing to send: balance too low once the storage reserve and fees are deducted'));
    const amount = spendable - BigInt(first.context.feeBound);
    if (amount <= 0n) throw new Error(l10n('Rien à envoyer : solde insuffisant une fois la réserve de stockage et les frais déduits', 'Nothing to send: balance too low once the storage reserve and fees are deducted'));
    return this.buildTransfer(params.to, amount);
  }

  async buildTransfer(toInput: string, amount: bigint): Promise<NearUnsigned> {
    const to = toInput.trim();
    const problem = nearAccountIdProblem(to);
    if (problem) throw new Error(problem);
    if (to === this.address) throw new Error(l10n('Envoi à soi-même impossible', 'Cannot send to yourself'));
    if (amount <= 0n) throw new Error(l10n('Montant invalide', 'Invalid amount'));
    const built = await this.backend.build(to, amount.toString());
    const s = built.summary;
    if (s.receiverId !== to || s.signerId !== this.address || s.deposit !== amount.toString() || s.receiverKind !== nearAccountKind(to)) {
      throw new Error(l10n('Le transfert construit par Rust ne correspond pas à la demande', 'The transfer built by Rust does not match the request'));
    }
    return {
      family: 'near',
      tx: built.tx,
      summary: s,
      context: built.context,
      recipient: to,
      amount,
      maxFee: BigInt(built.context.feeBound),
      size: { family: 'near' },
    };
  }

  /** Ledger: same checks as `signTx`; Rust re-reads the key, shows its dialog, then the device signs. */
  signTxHw(unsigned: NearUnsigned, deviceId: string): Promise<NearSigned> {
    if (!this.hw) return Promise.reject(new Error(l10n('Ce compte n’est pas un hardware wallet', 'This account is not a hardware wallet')));
    return this.signTx(unsigned, deviceId);
  }

  /** Rust: live checks, native dialog (receiver, amount, fee bound, signing account), signature. */
  async signTx(unsigned: NearUnsigned, password: string): Promise<NearSigned> {
    const res = await this.backend.sign(unsigned.tx, password);
    if (res.hash !== unsigned.summary.hash) throw new Error(l10n('Hash NEAR inattendu', 'Unexpected NEAR hash'));
    return { family: 'near', signed: res.signed, hash: res.hash, summary: res.summary };
  }

  /** Rust verifies the signature and that the node's hash is ours. A failed execution throws. */
  async broadcast(signed: NearSigned): Promise<string> {
    const out = await this.backend.broadcast(signed.signed);
    if (out.hash !== signed.hash) throw new Error(l10n('Hash diffusé inattendu', 'Unexpected broadcast hash'));
    if (out.status === 'failure') throw new Error(l10n(`Transfert NEAR échoué sur la chaîne${out.message ? ` : ${out.message}` : ''}`, `NEAR transfer failed on chain${out.message ? `: ${out.message}` : ''}`));
    return out.hash;
  }

  txStatus(hash: string): Promise<NearTxOutcome> {
    return this.backend.txStatus(hash);
  }

  async getHistory(): Promise<HistoryItem[]> {
    const list = await this.backend.txs(this.address);
    return list.map((t) => {
      const out = t.from === this.address;
      const self = out && t.to === this.address;
      const item: HistoryItem = {
        id: t.hash,
        chainKey: this.chain.key,
        assetId: 'near',
        direction: self ? 'self' : out ? 'out' : 'in',
        amount: BigInt(t.deposit || '0'),
        status: t.success ? 'confirmed' : 'failed',
        kind: t.kind === 'transfer' ? 'transfer' : 'contract',
      };
      if (out) item.fee = BigInt(t.fee || '0');
      const counterparty = out ? t.to : t.from;
      if (counterparty && !self) item.counterparty = counterparty;
      if (t.time) item.time = t.time;
      return item;
    });
  }
}
