// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cosmos Hub adapter (ATOM). Thin on purpose: reads, MsgSend building (chain id, account number,
// sequence, timeout height, simulated gas and fee filled by Rust, encoded by wallet-core),
// signature and broadcast are Rust commands (`cosmos_*`, docs/IPC.md §2.11). This adapter only
// validates input and checks that what Rust built is what was asked (recipient, amount, memo).

import {
  call,
  cosmosAddressProblem,
  isCosmosAddress,
  type CosmosAccountInfo,
  type CosmosContext,
  type CosmosHistoryEntry,
  type CosmosTxStatus,
  type CosmosTxSummary,
  type CosmosWarning,
} from '@kyro/shared';
import type { CosmosChain } from '../registry';
import { accountArg, type Balance, type BuildParams, type ChainAdapter, type FeeEstimates, type HistoryItem } from '../types';

// ---------------------------------------------------------------- Rust contract (§2.11)

export type { CosmosAccountInfo, CosmosContext, CosmosHistoryEntry, CosmosTxStatus, CosmosTxSummary, CosmosWarning };

/** Longest memo the Hub accepts (`max_memo_characters`). */
export const COSMOS_MAX_MEMO = 512;

export interface CosmosBackend {
  account(address: string): Promise<CosmosAccountInfo>;
  txs(address: string): Promise<CosmosHistoryEntry[]>;
  build(to: string, amount: string, memo?: string): Promise<{ signDoc: string; summary: CosmosTxSummary; context: CosmosContext }>;
  sign(signDoc: string, password: string): Promise<{ tx: string; hash: string; summary: CosmosTxSummary; context: CosmosContext }>;
  broadcast(tx: string): Promise<string>;
  txStatus(hash: string): Promise<CosmosTxStatus>;
}

/** The typed `cosmos_*` commands of `@kyro/shared` (docs/IPC.md §2.11), for vault account `account`. */
export function rustCosmosBackend(account = 0): CosmosBackend {
  const acct = accountArg(account);
  return {
    account: (address) => call('cosmos_account', { address }),
    txs: (address) => call('cosmos_txs', { address }),
    build: (to, amount, memo) => call('cosmos_build_tx', { to, amount, ...(memo ? { memo } : {}), ...acct }),
    sign: (signDoc, password) => call('cosmos_sign_tx', { signDoc, password, ...acct }),
    broadcast: (tx) => call('cosmos_broadcast', { tx, ...acct }),
    txStatus: (hash) => call('cosmos_tx_status', { hash }),
  };
}

// ---------------------------------------------------------------- addresses and amounts

// Address shape: `cosmosAddressProblem` / `isCosmosAddress` of `@kyro/shared` (Rust checks it
// again, `cosmos_normalize_address`, on every command).
export { cosmosAddressProblem, isCosmosAddress };

/** `"1.5"` ATOM → `1500000n` uatom (at most 6 decimals). */
export function atomToUatom(input: string): bigint {
  const s = input.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error('Montant ATOM invalide (6 décimales au plus)');
  const [int = '0', frac = ''] = s.split('.');
  return BigInt(int) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

/**
 * Longest memo the Send screen accepts: what the native dialog shows in full (Rust cuts the
 * displayed memo at 256 characters, which would require the reinforced confirmation).
 */
export const COSMOS_UI_MAX_MEMO = 256;

/** Memo the user typed: at most 256 characters, no control character. */
export function cosmosMemoProblem(memo: string): string | null {
  if ([...memo].length > COSMOS_UI_MAX_MEMO) return `Mémo trop long (${COSMOS_UI_MAX_MEMO} caractères au plus)`;
  for (const c of memo) {
    const n = c.codePointAt(0) ?? 0;
    if (n < 0x20 || (n >= 0x7f && n <= 0x9f)) return 'Le mémo contient un caractère de contrôle (retour à la ligne…)';
  }
  return null;
}

// ---------------------------------------------------------------- adapter

export interface CosmosUnsigned {
  family: 'cosmos';
  signDoc: string;
  summary: CosmosTxSummary;
  context: CosmosContext;
  recipient: string;
  /** uatom. */
  amount: bigint;
  memo: string;
  /** Fee set by Rust (uatom): the whole cost on top of the amount. */
  maxFee: bigint;
  size: { family: 'cosmos'; gasLimit: number };
}

export interface CosmosSigned {
  family: 'cosmos';
  /** TxRaw, base64. */
  tx: string;
  hash: string;
  summary: CosmosTxSummary;
}

export interface CosmosAdapterOptions {
  chain: CosmosChain;
  address: string;
  backend?: CosmosBackend;
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
}

export class CosmosAdapter implements ChainAdapter<'cosmos'> {
  readonly family = 'cosmos' as const;
  readonly chain: CosmosChain;
  private readonly address: string;
  private readonly backend: CosmosBackend;

  constructor(opts: CosmosAdapterOptions) {
    if (!isCosmosAddress(opts.address)) throw new Error('Adresse Cosmos invalide');
    this.chain = opts.chain;
    this.address = opts.address.trim().toLowerCase();
    this.backend = opts.backend ?? rustCosmosBackend(opts.account ?? 0);
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return isCosmosAddress(address);
  }

  account(): Promise<CosmosAccountInfo> {
    return this.backend.account(this.address);
  }

  /** ATOM balance, plus `spendable` (minus what is still vesting). */
  async getBalance(): Promise<Array<Balance & { spendable: bigint }>> {
    const acc = await this.backend.account(this.address);
    return [{ assetId: 'cosmos', amount: BigInt(acc.balance), spendable: BigInt(acc.spendable) }];
  }

  /** No fee to choose: Rust simulates the transaction and prices the gas at the fee market. */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'cosmos' as const };
    const eta = this.chain.blockTimeSecs;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: 'frais calculés par simulation (≈ 0,0008 ATOM)',
      fetchedAt: Date.now(),
    });
  }

  /** `ChainAdapter` entry point. `max`: spendable minus the fee Rust sets, built twice. */
  async buildTx(params: BuildParams): Promise<CosmosUnsigned> {
    if (params.asset.kind !== 'native') throw new Error('Actif Cosmos inattendu');
    const memo = params.memo ?? '';
    if (!params.max) return this.buildSend({ to: params.to, amount: params.amount.toString(), memo });
    const spendable = BigInt((await this.backend.account(this.address)).spendable);
    // First pass with a fee ceiling of 0.01 ATOM; then exactly spendable − fee.
    const first = await this.buildSend({ to: params.to, amount: (spendable - 10_000n).toString(), memo }).catch(() => null);
    if (!first) throw new Error('Solde insuffisant pour payer les frais');
    const amount = spendable - BigInt(first.summary.fee);
    if (amount <= 0n) throw new Error('Rien à envoyer après les frais');
    return this.buildSend({ to: params.to, amount: amount.toString(), memo });
  }

  /** `amount`: uatom. Rust re-checks balance, sequence and chain id. */
  async buildSend(params: { to: string; amount: string; memo?: string }): Promise<CosmosUnsigned> {
    const to = params.to.trim().toLowerCase();
    const problem = cosmosAddressProblem(to);
    if (problem) throw new Error(problem);
    if (to === this.address) throw new Error('Envoi à soi-même impossible');
    if (!/^\d+$/.test(params.amount) || BigInt(params.amount) <= 0n) throw new Error('Montant en uatom invalide');
    const memo = params.memo ?? '';
    const memoProblem = cosmosMemoProblem(memo);
    if (memoProblem) throw new Error(memoProblem);
    const built = await this.backend.build(to, params.amount, memo || undefined);
    const s = built.summary;
    if (s.to !== to || s.from !== this.address || s.amount !== params.amount || (s.memo ?? '') !== memo || s.chainId !== this.chain.chainId || s.requiresExtraConfirmation) {
      throw new Error('La transaction construite par Rust ne correspond pas à la demande');
    }
    return {
      family: 'cosmos',
      signDoc: built.signDoc,
      summary: s,
      context: built.context,
      recipient: to,
      amount: BigInt(params.amount),
      memo,
      maxFee: BigInt(s.fee),
      size: { family: 'cosmos', gasLimit: s.gasLimit },
    };
  }

  /** Rust: live checks, native dialog, signature. */
  async signTx(unsigned: CosmosUnsigned, password: string): Promise<CosmosSigned> {
    const res = await this.backend.sign(unsigned.signDoc, password);
    if (!/^[0-9A-F]{64}$/i.test(res.hash)) throw new Error('Hash Cosmos inattendu');
    return { family: 'cosmos', tx: res.tx, hash: res.hash, summary: res.summary };
  }

  /** Rust verifies the signature and that the server's hash is ours. */
  async broadcast(signed: CosmosSigned): Promise<string> {
    const hash = await this.backend.broadcast(signed.tx);
    if (hash.toUpperCase() !== signed.hash.toUpperCase()) throw new Error('Hash diffusé inattendu');
    return hash;
  }

  txStatus(hash: string): Promise<CosmosTxStatus> {
    return this.backend.txStatus(hash);
  }

  async getHistory(): Promise<HistoryItem[]> {
    const list = await this.backend.txs(this.address);
    return list.map((t) => {
      const out = t.from === this.address;
      const item: HistoryItem = {
        id: t.hash,
        chainKey: this.chain.key,
        assetId: 'cosmos',
        direction: out ? (t.to === this.address ? 'self' : 'out') : 'in',
        amount: BigInt(t.amount || '0'),
        status: t.success ? 'confirmed' : 'failed',
        kind: 'transfer',
      };
      if (out) item.fee = BigInt(t.fee || '0');
      const counterparty = out ? t.to : t.from;
      if (counterparty) item.counterparty = counterparty;
      if (t.time) item.time = t.time;
      if (t.memo) item.note = `Mémo : ${t.memo}`;
      return item;
    });
  }
}
