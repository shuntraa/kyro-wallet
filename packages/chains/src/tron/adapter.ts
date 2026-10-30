// SPDX-License-Identifier: GPL-3.0-or-later
//
// TRON adapter (TRX + TRC-20). Thin on purpose: every read, the transaction building, the
// signature and the broadcast are Rust commands (`tron_*`, docs/IPC.md §2.5).
// - Rust builds `raw_data` itself from the latest block (never the server's
//   `createtransaction`), simulates the energy of a TRC-20 transfer and sets `fee_limit`;
// - Rust decodes it again before signing, shows the native dialog (bandwidth / energy
//   available, TRX burned at most, activation of a new account) and signs `sha256(raw_data)`;
// - this adapter only checks that what Rust built is what was asked (recipient, amount, token).

import * as bitcoin from 'bitcoinjs-lib';
import { call, type Network } from '@kyro/shared';
import type { TronChain } from '../registry';
import type { HistoryItem } from '../types';

// ---------------------------------------------------------------- Rust contract (§2.5)

export interface TronAccountInfo {
  address: string;
  /** Has received TRX at least once. Sending TRX to a non-existing account activates it (≈ 1.1 TRX burned). */
  exists: boolean;
  /** Sun, decimal string. */
  balance: string;
  freeBandwidthLimit: number;
  freeBandwidthUsed: number;
  bandwidthLimit: number;
  bandwidthUsed: number;
  energyLimit: number;
  energyUsed: number;
}

export type TronAction =
  | { type: 'trxTransfer'; to: string; amount: string }
  | { type: 'trc20Transfer'; contract: string; to: string; amount: string; callValue: string }
  | { type: 'contractCall'; contract: string; selector: string; data: string; callValue: string };

export type TronWarning = { kind: 'unknownCall'; selector: string } | { kind: 'callValue' } | { kind: 'memo' } | { kind: 'highFeeLimit' };

export interface TronTxSummary {
  txid: string;
  owner: string;
  action: TronAction;
  feeLimit: string;
  expiration: number;
  timestamp: number;
  refBlockBytes: string;
  refBlockHash: string;
  memo: string;
  rawSize: number;
  warnings: TronWarning[];
  requiresExtraConfirmation: boolean;
}

/** Amounts in sun (decimal strings) unless stated. */
export interface TronEstimate {
  bandwidthNeeded: number;
  freeBandwidth: number;
  stakedBandwidth: number;
  bandwidthBurn: string;
  activationFee: string;
  recipientExists: boolean;
  energyNeeded: number;
  energyAvailable: number;
  /** Sun per energy unit. */
  energyFee: number;
  energyBurn: string;
  feeLimit: string;
  totalBurn: string;
  totalBurnMax: string;
  balance: string;
}

export interface TronHistoryEntry {
  txid: string;
  kind: 'trx' | 'trc20';
  from: string | null;
  to: string | null;
  amount: string;
  token?: { contract: string; symbol: string; decimals: number };
  timestamp: number | null;
  status: 'confirmed' | 'failed';
}

export interface TronBackend {
  account(address: string): Promise<TronAccountInfo>;
  trc20Balance(contract: string, address: string): Promise<string>;
  txs(address: string): Promise<TronHistoryEntry[]>;
  build(to: string, amount: string, token?: string): Promise<{ raw: string; txid: string; summary: TronTxSummary; estimate: TronEstimate }>;
  sign(raw: string, password: string, token?: { symbol: string; decimals: number }): Promise<{ signature: string; txid: string; summary: TronTxSummary; estimate: TronEstimate }>;
  broadcast(raw: string, signature: string): Promise<string>;
}

/** `tron_*` are not (yet) in `@kyro/shared`'s typed `Commands`: untyped view of `call`, typed here. */
type RawCall = <R>(cmd: string, args?: Record<string, unknown>) => Promise<R>;
const rawCall = call as unknown as RawCall;

export function rustTronBackend(invoke: RawCall = rawCall): TronBackend {
  return {
    account: (address) => invoke('tron_account', { address }),
    trc20Balance: (contract, address) => invoke('tron_trc20_balance', { contract, address }),
    txs: (address) => invoke('tron_txs', { address }),
    build: (to, amount, token) => invoke('tron_build_tx', { to, amount, ...(token ? { token } : {}) }),
    sign: (raw, password, token) => invoke('tron_sign_tx', { raw, password, ...(token ? { token } : {}) }),
    broadcast: (raw, signature) => invoke('tron_broadcast', { raw, signature }),
  };
}

// ---------------------------------------------------------------- tokens

export interface Trc20Token {
  contract: string;
  symbol: string;
  name: string;
  decimals: number;
}

/**
 * USDT per network. Mainnet: Tether's contract. Nile has **its own** test USDT
 * (TXYZopYR…, checked on chain 2026-10-30: symbol USDT, name "Tether USD", 6 decimals), unrelated
 * to mainnet's; obtained from TRON's TronFAQBot (`!nile_usdt <address>`), not the captcha faucet.
 */
export const TRON_USDT: Record<Network, Trc20Token> = {
  mainnet: { contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
  testnet: { contract: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
};

export const tronAssetId = (token?: Trc20Token): string => (token ? `trc20:${token.contract}` : 'trx');

/** `T…` address: base58check, 21 bytes, prefix 0x41. */
export function isTronAddress(address: string): boolean {
  try {
    const { version, hash } = bitcoin.address.fromBase58Check(address.trim());
    return version === 0x41 && hash.length === 20;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- adapter

export interface TronUnsigned {
  family: 'tron';
  /** `raw_data` hex, built by Rust. */
  raw: string;
  txid: string;
  summary: TronTxSummary;
  estimate: TronEstimate;
  amount: bigint;
  recipient: string;
  token?: Trc20Token;
}

export interface TronSigned {
  family: 'tron';
  raw: string;
  /** 65 bytes r‖s‖v, hex. */
  signature: string;
  txid: string;
  summary: TronTxSummary;
  estimate: TronEstimate;
}

export interface TronAdapterOptions {
  chain: TronChain;
  address: string;
  backend?: TronBackend;
  /** TRC-20 tokens shown (default: USDT of the network). */
  tokens?: Trc20Token[];
}

export class TronAdapter {
  readonly family = 'tron' as const;
  readonly chain: TronChain;
  readonly tokens: Trc20Token[];
  private readonly address: string;
  private readonly backend: TronBackend;

  constructor(opts: TronAdapterOptions) {
    if (!isTronAddress(opts.address)) throw new Error('Adresse TRON invalide');
    this.chain = opts.chain;
    this.address = opts.address;
    this.backend = opts.backend ?? rustTronBackend();
    this.tokens = opts.tokens ?? [TRON_USDT[opts.chain.network]];
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return isTronAddress(address);
  }

  account(): Promise<TronAccountInfo> {
    return this.backend.account(this.address);
  }

  async getBalance(): Promise<Array<{ assetId: string; amount: bigint }>> {
    const [acc, ...tokens] = await Promise.all([this.backend.account(this.address), ...this.tokens.map((t) => this.backend.trc20Balance(t.contract, this.address))]);
    return [{ assetId: tronAssetId(), amount: BigInt(acc.balance) }, ...this.tokens.map((t, i) => ({ assetId: tronAssetId(t), amount: BigInt(tokens[i] ?? '0') }))];
  }

  /**
   * Rust builds from the latest block. `amount`: sun (TRX) or token units. The adapter checks
   * that Rust's decoding is exactly the request.
   */
  async buildTx(params: { to: string; amount: bigint; token?: Trc20Token }): Promise<TronUnsigned> {
    const to = params.to.trim();
    if (!isTronAddress(to)) throw new Error('Adresse TRON invalide');
    if (params.amount <= 0n) throw new Error('Montant invalide');
    if (!params.token && to === this.address) throw new Error('TRON refuse un envoi de TRX à soi-même');
    const built = await this.backend.build(to, params.amount.toString(), params.token?.contract);
    const a = built.summary.action;
    const ok = params.token
      ? a.type === 'trc20Transfer' && a.contract === params.token.contract && a.to === to && a.amount === params.amount.toString() && a.callValue === '0'
      : a.type === 'trxTransfer' && a.to === to && a.amount === params.amount.toString();
    // Kyro's own builds carry no memo, no call value, no unknown call; only a very high
    // fee_limit (huge energy) may be flagged.
    const unexpected = built.summary.warnings.some((w) => w.kind !== 'highFeeLimit');
    if (!ok || built.summary.owner !== this.address || built.summary.txid !== built.txid || unexpected) {
      throw new Error('La transaction construite par Rust ne correspond pas à la demande');
    }
    return { family: 'tron', raw: built.raw, txid: built.txid, summary: built.summary, estimate: built.estimate, amount: params.amount, recipient: to, ...(params.token ? { token: params.token } : {}) };
  }

  /** Rust: password, decoding, live resources, native dialog (+ reinforced one), signature. */
  async signTx(unsigned: TronUnsigned, password: string): Promise<TronSigned> {
    const hint = unsigned.token ? { symbol: unsigned.token.symbol, decimals: unsigned.token.decimals } : undefined;
    const res = await this.backend.sign(unsigned.raw, password, hint);
    if (res.txid !== unsigned.txid || !/^[0-9a-f]{130}$/.test(res.signature)) throw new Error('Signature TRON inattendue');
    return { family: 'tron', raw: unsigned.raw, signature: res.signature, txid: res.txid, summary: res.summary, estimate: res.estimate };
  }

  /** Rust checks the signature recovers to our address and that the server's txid matches. */
  async broadcast(signed: TronSigned): Promise<string> {
    const txid = await this.backend.broadcast(signed.raw, signed.signature);
    if (txid !== signed.txid) throw new Error('txid diffusé inattendu');
    return txid;
  }

  async getHistory(): Promise<HistoryItem[]> {
    const list = await this.backend.txs(this.address);
    return list.map((t) => {
      const out = t.from === this.address;
      const token = t.token ? this.tokens.find((k) => k.contract === t.token?.contract) : undefined;
      const item: HistoryItem = {
        id: t.txid,
        chainKey: this.chain.key,
        assetId: t.kind === 'trx' ? 'trx' : token ? tronAssetId(token) : `trc20:${t.token?.contract ?? ''}`,
        direction: out && t.to === this.address ? 'self' : out ? 'out' : 'in',
        amount: BigInt(t.amount || '0'),
        status: t.status === 'failed' ? 'failed' : 'confirmed',
        kind: 'transfer',
      };
      const counterparty = out ? t.to : t.from;
      if (counterparty) item.counterparty = counterparty;
      if (t.timestamp) item.time = t.timestamp;
      return item;
    });
  }
}
