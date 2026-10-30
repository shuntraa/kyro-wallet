// SPDX-License-Identifier: GPL-3.0-or-later

import type { BtcTxSummary, EvmTokenHint, EvmTxRequest, EvmTxSummary } from '@kyro/shared';
import type { AssetDef, Chain, Family } from './registry';

export type FeeLevel = 'slow' | 'normal' | 'fast';
export type FeeChoice = FeeLevel | 'custom';

/** Fee parameters, per family. Custom fees use the same shapes. */
export type FeeParams =
  | { family: 'evm'; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { family: 'btc'; satPerVb: number }
  | { family: 'sol'; microLamports: bigint };

export interface FeeOption {
  level: FeeLevel;
  params: FeeParams;
  /** Rough confirmation delay. */
  etaSecs: number;
}

export interface FeeEstimates {
  options: Record<FeeLevel, FeeOption>;
  /** Network floor: EVM next base fee, BTC minimum relay fee, Solana 0. */
  minimum: FeeParams;
  /** Human hint ("4,2 gwei", "3 sat/vB"). */
  hint: string;
  fetchedAt: number;
}

/** What the size of a tx is, so fee options can be priced without rebuilding. */
export type SizeHint = { family: 'evm'; gasLimit: bigint } | { family: 'btc'; vsize: number } | { family: 'sol'; computeUnits: number; signatures: number };

export interface Balance {
  assetId: string;
  amount: bigint;
}

export interface BuildParams {
  asset: AssetDef;
  to: string;
  /** Base units. Ignored when `max` is true. */
  amount: bigint;
  fee: FeeParams;
  /** Send everything (native: balance minus fee). */
  max?: boolean;
}

export interface EvmUnsigned {
  family: 'evm';
  tx: EvmTxRequest;
  asset: AssetDef;
  amount: bigint;
  /** Recipient (for ERC-20, the token recipient, not the contract). */
  recipient: string;
  maxFee: bigint;
  size: SizeHint;
  /** Passed to `evm_sign_tx` so the native dialog shows a readable token amount. */
  token?: EvmTokenHint;
  kind: 'transfer' | 'approval' | 'swap' | 'contract';
}
export interface BtcUnsigned {
  family: 'btc';
  psbt: string;
  amount: bigint;
  recipient: string;
  fee: bigint;
  maxFee: bigint;
  /** Computed locally from the PSBT, before signing (Rust re-decodes it for the native dialog). */
  summary: BtcTxSummary;
  size: SizeHint;
}
export interface SolUnsigned {
  family: 'sol';
  /** base64 compiled message bytes. */
  message: string;
  amount: bigint;
  recipient: string;
  maxFee: bigint;
  summary: string;
  size: SizeHint;
}

export interface EvmSigned {
  family: 'evm';
  rawTx: string;
  hash: string;
}
export interface BtcSigned {
  family: 'btc';
  hex: string;
  txid: string;
}
export interface SolSigned {
  family: 'sol';
  wire: string;
  signature: string;
}

export interface FamilyTypes {
  evm: { unsigned: EvmUnsigned; signed: EvmSigned };
  btc: { unsigned: BtcUnsigned; signed: BtcSigned };
  sol: { unsigned: SolUnsigned; signed: SolSigned };
}
export type AnyUnsigned = EvmUnsigned | BtcUnsigned | SolUnsigned;
export type AnySigned = EvmSigned | BtcSigned | SolSigned;

export type HistoryDirection = 'in' | 'out' | 'self';
export type HistoryStatus = 'pending' | 'confirmed' | 'failed';

export interface HistoryItem {
  id: string;
  chainKey: string;
  assetId: string;
  direction: HistoryDirection;
  /** Absolute value, base units. */
  amount: bigint;
  fee?: bigint;
  counterparty?: string;
  /** ms epoch, undefined while pending without timestamp. */
  time?: number;
  status: HistoryStatus;
  kind: 'transfer' | 'swap' | 'approval' | 'contract';
}

export interface ChainAdapter<F extends Family = Family> {
  readonly family: F;
  readonly chain: Chain;
  getAddress(): string;
  getBalance(): Promise<Balance[]>;
  estimateFees(): Promise<FeeEstimates>;
  /** Validate an address for this chain (format + checksum). */
  isValidAddress(address: string): boolean;
  buildTx(params: BuildParams): Promise<FamilyTypes[F]['unsigned']>;
  /** Delegates to the Rust `*_sign_*` command (password + native dialog). */
  signTx(unsigned: FamilyTypes[F]['unsigned'], password: string): Promise<FamilyTypes[F]['signed']>;
  broadcast(signed: FamilyTypes[F]['signed']): Promise<string>;
  getHistory(): Promise<HistoryItem[]>;
}

export type AnyAdapter = ChainAdapter<'btc'> | ChainAdapter<'evm'> | ChainAdapter<'sol'>;

/** Sign + broadcast with a union-typed adapter. */
export async function signAndBroadcast(adapter: AnyAdapter, unsigned: AnyUnsigned, password: string): Promise<string> {
  if (adapter.family !== unsigned.family) throw new Error('Famille de transaction incohérente');
  const a = adapter as ChainAdapter<Family>;
  const signed = await a.signTx(unsigned as never, password);
  return a.broadcast(signed as never);
}

export type { EvmTxSummary };
