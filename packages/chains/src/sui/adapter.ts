// SPDX-License-Identifier: GPL-3.0-or-later
//
// Sui adapter (SUI). Thin on purpose: reads, transfer building (gas coins, reference gas price,
// budget from a simulation, BCS encoded by wallet-core), signature and execution are Rust
// commands (`sui_*`, docs/IPC.md §2.11). This adapter only validates input and checks that what
// Rust built is what was asked (recipient, amount or « tout le solde », sender, coin type).

import { call, type SuiBalance, type SuiBuilt, type SuiContext, type SuiHistoryEntry, type SuiTxStatus, type SuiTxSummary, type SuiWarning } from '@kyro/shared';
import type { SuiChain } from '../registry';
import { accountArg, type Balance, type BuildParams, type ChainAdapter, type FeeEstimates, type HistoryItem } from '../types';

export type { SuiBalance, SuiContext, SuiHistoryEntry, SuiTxStatus, SuiTxSummary, SuiWarning };

export interface SuiBackend {
  balance(address: string): Promise<SuiBalance>;
  txs(address: string): Promise<SuiHistoryEntry[]>;
  /** `amount` MIST; null = the whole balance. */
  build(to: string, amount: bigint | null): Promise<SuiBuilt>;
  sign(bcs: string, password: string): Promise<SuiBuilt & { signature: string; digest: string }>;
  broadcast(bcs: string, signature: string): Promise<string>;
  txStatus(digest: string): Promise<SuiTxStatus>;
}

/** The typed `sui_*` commands of `@kyro/shared` (docs/IPC.md §2.11), for vault account `account`. */
export function rustSuiBackend(account = 0): SuiBackend {
  const acct = accountArg(account);
  return {
    balance: (address) => call('sui_balance', { address }),
    txs: (address) => call('sui_txs', { address }),
    build: (to, amount) => call('sui_build_tx', amount === null ? { to, all: true, ...acct } : { to, amount: amount.toString(), ...acct }),
    sign: (bcs, password) => call('sui_sign_tx', { bcs, password, ...acct }),
    broadcast: (bcs, signature) => call('sui_broadcast', { bcs, signature, ...acct }),
    txStatus: (digest) => call('sui_tx_status', { digest }),
  };
}

export const SUI_COIN_TYPE = '0x2::sui::SUI';

/** Full Sui address: `0x` + exactly 64 hex characters (no checksum exists on Sui). */
export function isSuiAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(address.trim());
}

/** Why an input is not a full Sui address (null when it is). Same rules as wallet-core. */
export function suiAddressProblem(address: string): string | null {
  const a = address.trim();
  if (a === '') return null;
  if (a.endsWith('.sui') || a.startsWith('@')) return 'Les noms SuiNS ne sont pas pris en charge : colle l’adresse 0x… complète.';
  if (!a.startsWith('0x')) return 'Adresse Sui : 0x suivi de 64 caractères hexadécimaux.';
  if (/^0x[0-9a-fA-F]{1,63}$/.test(a)) return 'Forme courte refusée : il faut les 64 caractères après 0x.';
  if (!isSuiAddress(a)) return 'Adresse Sui invalide (0x + 64 caractères hexadécimaux).';
  return null;
}

/** `0x` + lowercase hex: how Rust prints addresses. */
export function normalizeSuiAddress(address: string): string {
  return address.trim().toLowerCase();
}

export interface SuiUnsigned {
  family: 'sui';
  /** BCS base64, what Rust signs (it decodes it again before the dialog). */
  bcs: string;
  summary: SuiTxSummary;
  context: SuiContext;
  recipient: string;
  /** MIST asked; for « tout le solde », what the simulation says the recipient receives. */
  amount: bigint;
  all: boolean;
  /** Gas budget (MIST): the most the transfer can cost on top of the amount. */
  maxFee: bigint;
  size: { family: 'sui' };
}

export interface SuiSigned {
  family: 'sui';
  bcs: string;
  signature: string;
  digest: string;
  summary: SuiTxSummary;
}

export interface SuiAdapterOptions {
  chain: SuiChain;
  address: string;
  backend?: SuiBackend;
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
}

export class SuiAdapter implements ChainAdapter<'sui'> {
  readonly family = 'sui' as const;
  readonly chain: SuiChain;
  private readonly address: string;
  private readonly backend: SuiBackend;

  constructor(opts: SuiAdapterOptions) {
    if (!isSuiAddress(opts.address)) throw new Error('Adresse Sui invalide');
    this.chain = opts.chain;
    this.address = normalizeSuiAddress(opts.address);
    this.backend = opts.backend ?? rustSuiBackend(opts.account ?? 0);
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return isSuiAddress(address);
  }

  balanceInfo(): Promise<SuiBalance> {
    return this.backend.balance(this.address);
  }

  /** Total SUI, plus `spendable` = what sits in coin objects (the address balance is not spent by Kyro). */
  async getBalance(): Promise<Array<Balance & { spendable: bigint }>> {
    const b = await this.backend.balance(this.address);
    return [{ assetId: 'sui', amount: BigInt(b.total), spendable: BigInt(b.coin) }];
  }

  /** No fee to choose: Rust uses the reference gas price and a budget from a simulation. */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'sui' as const };
    const eta = this.chain.blockTimeSecs;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: 'frais fixés par le réseau (prix du gaz de référence, ≈ 0,002 SUI)',
      fetchedAt: Date.now(),
    });
  }

  async buildTx(params: BuildParams): Promise<SuiUnsigned> {
    if (params.asset.kind !== 'native') throw new Error('Actif Sui inattendu');
    const problem = suiAddressProblem(params.to);
    if (problem) throw new Error(problem);
    const to = normalizeSuiAddress(params.to);
    if (!isSuiAddress(to)) throw new Error('Adresse Sui invalide');
    const all = !!params.max;
    if (!all && params.amount <= 0n) throw new Error('Montant invalide');
    const built = await this.backend.build(to, all ? null : params.amount);
    const s = built.summary;
    const amountOk = all ? s.amount === null : s.amount === params.amount.toString();
    const warningsOk = s.warnings.every((w) => (all && w.kind === 'sendAll') || (to === this.address && w.kind === 'selfTransfer'));
    if (!amountOk || !warningsOk || s.recipient !== to || s.sender !== this.address || s.coinType !== SUI_COIN_TYPE) {
      throw new Error('Le transfert construit par Rust ne correspond pas à la demande');
    }
    return {
      family: 'sui',
      bcs: built.bcs,
      summary: s,
      context: built.context,
      recipient: to,
      amount: all ? BigInt(built.context.receives ?? '0') : params.amount,
      all,
      maxFee: BigInt(s.gasBudget),
      size: { family: 'sui' },
    };
  }

  /** Rust: live checks, simulation, native dialog, signature. */
  async signTx(unsigned: SuiUnsigned, password: string): Promise<SuiSigned> {
    const res = await this.backend.sign(unsigned.bcs, password);
    if (res.digest !== unsigned.summary.digest || res.bcs !== unsigned.bcs) throw new Error('Transaction Sui signée inattendue');
    return { family: 'sui', bcs: res.bcs, signature: res.signature, digest: res.digest, summary: res.summary };
  }

  /** Rust verifies the signature and that the executed digest is ours. */
  async broadcast(signed: SuiSigned): Promise<string> {
    const digest = await this.backend.broadcast(signed.bcs, signed.signature);
    if (digest !== signed.digest) throw new Error('Empreinte diffusée inattendue');
    return digest;
  }

  txStatus(digest: string): Promise<SuiTxStatus> {
    return this.backend.txStatus(digest);
  }

  async getHistory(): Promise<HistoryItem[]> {
    const list = await this.backend.txs(this.address);
    return list.map((t) => suiHistoryItem(t, this.address, this.chain.key));
  }
}

/** One `sui_txs` entry as a history row: the net SUI change of `me`, fees separated when we sent it. */
export function suiHistoryItem(t: SuiHistoryEntry, me: string, chainKey = 'sui'): HistoryItem {
  const change = BigInt(t.change);
  const fee = t.fee !== null ? BigInt(t.fee) : 0n;
  const sent = t.sender === me;
  // Outgoing: what left besides the gas. Incoming: what arrived.
  const amount = sent ? -change - fee : change;
  const direction = sent ? (amount > 0n ? 'out' : 'self') : 'in';
  const item: HistoryItem = {
    id: t.digest,
    chainKey,
    assetId: 'sui',
    direction,
    amount: amount < 0n ? -amount : amount,
    status: t.success ? 'confirmed' : 'failed',
    kind: 'transfer',
  };
  if (sent && t.fee !== null) item.fee = fee;
  const counterparty = sent ? t.counterparty : (t.counterparty ?? t.sender);
  if (counterparty) item.counterparty = counterparty;
  if (t.timestamp) {
    const ms = Date.parse(t.timestamp);
    if (Number.isFinite(ms)) item.time = ms;
  }
  if (t.otherCoins) item.note = 'D’autres jetons ont bougé dans cette transaction (non détaillés)';
  if (!sent && amount <= 0n) item.suspect = 'zero';
  return item;
}
