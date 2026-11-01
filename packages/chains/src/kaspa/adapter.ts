// SPDX-License-Identifier: GPL-3.0-or-later
// Kaspa adapter (KAS). Thin on purpose: reads, payment building (coin selection over 20 receive + 20 change addresses, KIP-9 mass, fee), live re-read of the coins, signature (BIP340 Schnorr) and broadcast are Rust commands (`kas_*`, docs/IPC.md §2.11).

import { accountArg } from '../types';
import {
  call,
  l10n,
  isKaspaAddress,
  kaspaAddressProblem,
  type KaspaAccountInfo,
  type KaspaContext,
  type KaspaHistoryEntry,
  type KaspaTxSummary,
  type KaspaWarning,
} from '@kyro/shared';
import type { KaspaChain } from '../registry';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';

export type { KaspaAccountInfo, KaspaContext, KaspaHistoryEntry, KaspaTxSummary, KaspaWarning };

/** Smallest amount Rust builds (0.2 KAS): KIP-9 storage mass makes tiny outputs non-standard. */
export const KASPA_MIN_SEND = 20_000_000n;

export interface KaspaBackend {
  account(): Promise<KaspaAccountInfo>;
  txs(): Promise<KaspaHistoryEntry[]>;
  build(to: string, amount: bigint | 'max'): Promise<{ tx: string; summary: KaspaTxSummary; context: KaspaContext }>;
  sign(tx: string, password: string): Promise<{ tx: string; txId: string; summary: KaspaTxSummary }>;
  broadcast(tx: string): Promise<string>;
  txStatus(txid: string): Promise<{ found: boolean; accepted: boolean }>;
}

/** The typed `kas_*` commands of `@kyro/shared` (docs/IPC.md §2.11), for vault account `account`. */
export function rustKaspaBackend(account = 0): KaspaBackend {
  const acct = accountArg(account);
  return {
    account: () => call('kas_account', acct),
    txs: () => call('kas_txs', acct),
    build: (to, amount) => call('kas_build_tx', { to, ...(amount === 'max' ? { max: true } : { amount: amount.toString() }), ...acct }),
    sign: (tx, password) => call('kas_sign_tx', { tx, password, ...acct }),
    broadcast: (tx) => call('kas_broadcast', { tx, ...acct }),
    txStatus: (txid) => call('kas_tx_status', { txid }),
  };
}

/** `"12,5"` / `"12.5"` KAS → sompi (8 decimals, no rounding). */
export function kasToSompi(input: string): bigint {
  const s = input.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,8})?$/.test(s)) throw new Error(l10n('Montant KAS invalide (8 décimales au plus)', 'Invalid KAS amount (8 decimals at most)'));
  const [int = '0', frac = ''] = s.split('.');
  return BigInt(int) * 100_000_000n + BigInt(frac.padEnd(8, '0'));
}

export interface KaspaUnsigned {
  family: 'kas';
  /** Unsigned transaction JSON built by Rust (what `kas_sign_tx` signs). */
  tx: string;
  summary: KaspaTxSummary;
  context: KaspaContext;
  recipient: string;
  /** Sompi to the recipient. */
  amount: bigint;
  /** Fee set by Rust (sompi). */
  maxFee: bigint;
  size: { family: 'kas' };
}

export interface KaspaSigned {
  family: 'kas';
  tx: string;
  txId: string;
  summary: KaspaTxSummary;
}

export interface KaspaAdapterOptions {
  chain: KaspaChain;
  address: string;
  backend?: KaspaBackend;
  /** Vault account (docs/IPC.md §2.9) passed to every command; absent = 0. */
  account?: number;
}

export class KaspaAdapter implements ChainAdapter<'kas'> {
  readonly family = 'kas' as const;
  readonly chain: KaspaChain;
  private readonly address: string;
  private readonly backend: KaspaBackend;

  constructor(opts: KaspaAdapterOptions) {
    if (!isKaspaAddress(opts.address, opts.chain.network)) throw new Error(l10n('Adresse Kaspa invalide', 'Invalid Kaspa address'));
    this.chain = opts.chain;
    this.address = opts.address;
    this.backend = opts.backend ?? rustKaspaBackend(opts.account ?? 0);
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return isKaspaAddress(address, this.chain.network);
  }

  /** Why `address` cannot receive KAS here (French), or `null`. */
  addressProblem(address: string): string | null {
    return kaspaAddressProblem(address, this.chain.network);
  }

  account(): Promise<KaspaAccountInfo> {
    return this.backend.account();
  }

  /** KAS of the whole account; `spendable` = coins usable now (immature coinbase excluded). */
  async getBalance(): Promise<Array<Balance & { spendable: bigint }>> {
    const a = await this.backend.account();
    return [{ assetId: 'kas', amount: BigInt(a.balance), spendable: BigInt(a.spendable) }];
  }

  /** No fee to choose: Rust charges the minimum relay fee (100 sompi/gram), more when busy. */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'kas' as const };
    const eta = this.chain.blockTimeSecs;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: l10n('frais calculés par Rust sur la masse (≈ 0,002 KAS)', 'fee computed by Rust from the mass (≈ 0.002 KAS)'),
      fetchedAt: Date.now(),
    });
  }

  /** `max`: everything spendable minus the fee (one output, no change), computed by Rust. */
  async buildTx(params: BuildParams): Promise<KaspaUnsigned> {
    if (params.asset.kind !== 'native') throw new Error(l10n('Actif Kaspa inattendu', 'Unexpected Kaspa asset'));
    const to = params.to.trim();
    const problem = kaspaAddressProblem(to, this.chain.network);
    if (problem) throw new Error(problem.charAt(0).toUpperCase() + problem.slice(1));
    if (!params.max && params.amount < KASPA_MIN_SEND) throw new Error(l10n('Montant trop petit : au moins 0,2 KAS (masse de stockage de Kaspa, KIP-9)', 'Amount too small: at least 0.2 KAS (Kaspa storage mass, KIP-9)'));
    const built = await this.backend.build(to, params.max ? 'max' : params.amount);
    const s = built.summary;
    const payee = s.outputs.filter((o) => !o.isChange);
    const amount = payee.reduce((sum, o) => sum + BigInt(o.amount), 0n);
    // Self-send: the recipient is one of our addresses, so it is the change-flagged output.
    const self = payee.length === 0;
    const recipientOk = self ? s.outputs.some((o) => o.address === to) : payee.length === 1 && payee[0]?.address === to;
    const amountOk = params.max || self || amount === params.amount;
    // A high fee (busy network) is allowed: Rust's reinforced dialog shows it before signing.
    if (!recipientOk || !amountOk || s.outputs.some((o) => o.kind !== 'address') || s.warnings.some((w) => w.kind !== 'highFee')) {
      throw new Error(l10n('La transaction construite par Rust ne correspond pas à la demande', 'The transaction built by Rust does not match the request'));
    }
    return {
      family: 'kas',
      tx: built.tx,
      summary: s,
      context: built.context,
      recipient: to,
      amount: self ? BigInt(s.outputs.find((o) => o.address === to)?.amount ?? '0') : amount,
      maxFee: BigInt(s.fee),
      size: { family: 'kas' },
    };
  }

  /** Rust: live re-read of every coin, native dialog, signature. */
  async signTx(unsigned: KaspaUnsigned, password: string): Promise<KaspaSigned> {
    const res = await this.backend.sign(unsigned.tx, password);
    if (!/^[0-9a-f]{64}$/.test(res.txId) || res.txId !== unsigned.summary.txId) throw new Error(l10n('Identifiant Kaspa inattendu', 'Unexpected Kaspa ID'));
    return { family: 'kas', tx: res.tx, txId: res.txId, summary: res.summary };
  }

  /** Rust verifies every signature against the live coins and that the server's id is ours. */
  async broadcast(signed: KaspaSigned): Promise<string> {
    const id = await this.backend.broadcast(signed.tx);
    if (id !== signed.txId) throw new Error(l10n('Identifiant diffusé inattendu', 'Unexpected broadcast ID'));
    return id;
  }

  txStatus(txid: string): Promise<{ found: boolean; accepted: boolean }> {
    return this.backend.txStatus(txid);
  }

  async getHistory(): Promise<HistoryItem[]> {
    const list = await this.backend.txs();
    return list.map((t) => {
      const delta = BigInt(t.delta);
      const fee = t.fee !== null ? BigInt(t.fee) : undefined;
      // Outgoing: what left the account minus the fee; self-send: nothing but the fee.
      const out = delta < 0n;
      const amount = out ? -delta - (fee ?? 0n) : delta;
      const item: HistoryItem = {
        id: t.txid,
        chainKey: this.chain.key,
        assetId: 'kas',
        direction: out ? (amount <= 0n ? 'self' : 'out') : 'in',
        amount: amount < 0n ? 0n : amount,
        status: t.accepted ? 'confirmed' : 'pending',
        kind: 'transfer',
      };
      if (out && fee !== undefined) item.fee = fee;
      if (t.counterparty) item.counterparty = t.counterparty;
      if (t.time) item.time = t.time;
      return item;
    });
  }
}
