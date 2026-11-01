// SPDX-License-Identifier: GPL-3.0-or-later

import type { BtcTxSummary, EvmTokenHint, EvmTxRequest, EvmTxSummary } from '@kyro/shared';
import type { AssetDef, Chain, Family } from './registry';
import type { UtxoSigned, UtxoUnsigned } from './utxo/utxo';
import type { TronSigned, TronUnsigned } from './tron/adapter';
import type { XrpSigned, XrpUnsigned } from './xrp/adapter';
import type { CardanoSigned, CardanoUnsigned } from './cardano/adapter';
import type { StellarSigned, StellarUnsigned } from './stellar/adapter';
import type { NearSigned, NearUnsigned } from './near/adapter';
import type { SuiSigned, SuiUnsigned } from './sui/adapter';
import type { HbarSigned, HbarUnsigned } from './hedera/adapter';
import type { KaspaSigned, KaspaUnsigned } from './kaspa/adapter';
import type { DotSigned, DotUnsigned } from './polkadot/adapter';
import type { AlgoSigned, AlgoUnsigned } from './algorand/adapter';
import type { CardanoTokenSpec, StellarMemoSpec } from '@kyro/shared';

import { l10n } from '@kyro/shared';
export type FeeLevel = 'slow' | 'normal' | 'fast';
export type FeeChoice = FeeLevel | 'custom';

/** Fee parameters, per family. Custom fees use the same shapes. */
export type FeeParams =
  | { family: 'evm'; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { family: 'btc'; satPerVb: number }
  | { family: 'sol'; microLamports: bigint }
  /** TRON: no fee to choose. Rust burns bandwidth / energy (estimate shown, `fee_limit` caps it). */
  | { family: 'tron' }
  /** XRP Ledger: no fee to choose. Rust sets `Fee` from the open ledger (≈ 12 drops). */
  | { family: 'xrp' }
  /** Cardano: no fee to choose. Rust computes min_fee_a × size + min_fee_b. */
  | { family: 'ada' }
  /** Stellar: no fee to choose. Rust bids from Horizon's fee stats (≤ 0.01 XLM, usually 100 stroops charged). */
  | { family: 'xlm' }
  /** NEAR: no fee to choose. Charged at the block's gas price; Rust checks a bound. */
  | { family: 'near' }
  /** Sui: no fee to choose. Rust uses the reference gas price and a budget from a simulation. */
  | { family: 'sui' }
  /** Hedera: no fee to choose. Rust sets the max fee from the exchange rate (≈ $0.0001 charged). */
  | { family: 'hbar' }
  /** Kaspa: no fee to choose. Rust: 100 sompi per gram of relay mass (more when the network is busy). */
  | { family: 'kas' }
  /** Polkadot: no fee to choose (runtime weight + length fee, no tip), estimated by the node. */
  | { family: 'dot' }
  /** Algorand: no fee to choose. Rust sets the protocol minimum (0.001 ALGO), more under congestion. */
  | { family: 'algo' };

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
  /**
   * Bitcoin compact filters: rates are the average of the fees paid in the last blocks, not a
   * mempool estimate. The UI says so and suggests the custom rate.
   */
  source?: 'block-average';
}

/** What the size of a tx is, so fee options can be priced without rebuilding. */
export type SizeHint =
  | { family: 'evm'; gasLimit: bigint }
  | { family: 'btc'; vsize: number }
  | { family: 'sol'; computeUnits: number; signatures: number }
  /** TRON: bandwidth bytes charged, energy simulated (TRC-20). */
  | { family: 'tron'; bandwidth: number; energy: number }
  | { family: 'xrp' }
  | { family: 'ada' }
  | { family: 'xlm' }
  | { family: 'near' }
  | { family: 'sui' }
  | { family: 'hbar' }
  | { family: 'kas' }
  | { family: 'dot' }
  | { family: 'algo' };

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
  /** XRP Ledger only: destination tag (0 … 4 294 967 295). */
  destinationTag?: number;
  /** Cardano only: native token to send (its output carries the min-ADA; `amount` is then ignored). */
  cardanoToken?: CardanoTokenSpec;
  /** Cardano: CIP-20 message; Hedera: transaction memo (≤ 100 bytes); Algorand: transaction note (≤ 1024 bytes). Public and permanent. */
  memo?: string;
  /** Stellar only: memo (text / id / hash), public and permanent; exchanges often require one. */
  stellarMemo?: StellarMemoSpec;
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
  /** Shown by the interface only (the native dialog uses Rust's own token table). */
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
  /** base64 compiled message bytes (what Rust decodes and signs). */
  message: string;
  /** base64 wire transaction with empty signature slots. */
  wire: string;
  amount: bigint;
  /** Recipient wallet (owner of the destination token account for SPL). */
  recipient: string;
  /** Base fee + priority fee, lamports (rent for a new token account excluded). */
  maxFee: bigint;
  /** Rent deposit for the recipient's new token account, lamports (0n if it exists / SOL send). */
  ataRent: bigint;
  createsAta: boolean;
  /** SPL only. */
  mint?: string;
  destinationTokenAccount?: string;
  tokenProgram?: 'token' | 'token2022';
  /** Local one-liner (logs only; the UI shows the Rust decoding). */
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
  /** Litecoin / Dogecoin: Bitcoin shapes (PSBT, hex), the unsigned tx tagged `family: 'btc'`. */
  ltc: { unsigned: UtxoUnsigned; signed: UtxoSigned };
  doge: { unsigned: UtxoUnsigned; signed: UtxoSigned };
  /** Bitcoin Cash / Dash: same shapes (Bitcoin Cash comes back finalized from Rust). */
  bch: { unsigned: UtxoUnsigned; signed: UtxoSigned };
  dash: { unsigned: UtxoUnsigned; signed: UtxoSigned };
  /** TRON: `raw_data` built and decoded by Rust, its resource estimate. */
  tron: { unsigned: TronUnsigned; signed: TronSigned };
  /** XRP Ledger: Payment built and strictly decoded by Rust, with the live context. */
  xrp: { unsigned: XrpUnsigned; signed: XrpSigned };
  /** Cardano: transaction built (selection, fee, min-UTxO) and decoded by Rust. */
  ada: { unsigned: CardanoUnsigned; signed: CardanoSigned };
  /** Stellar: transaction built (Payment or CreateAccount) and strictly decoded by Rust. */
  xlm: { unsigned: StellarUnsigned; signed: StellarSigned };
  /** NEAR: one Transfer built and strictly decoded by Rust, with the live context. */
  near: { unsigned: NearUnsigned; signed: NearSigned };
  /** Sui: SUI transfer built (gas coins, budget) and decoded (BCS) by Rust. */
  sui: { unsigned: SuiUnsigned; signed: SuiSigned };
  /** Hedera: CryptoTransfer built (one copy per node) and decoded by Rust. */
  hbar: { unsigned: HbarUnsigned; signed: HbarSigned };
  /** Kaspa: payment built (coin selection, KIP-9 mass, fee) and decoded by Rust. */
  kas: { unsigned: KaspaUnsigned; signed: KaspaSigned };
  /** Polkadot: `transfer_keep_alive` payload built and strictly decoded by Rust. */
  dot: { unsigned: DotUnsigned; signed: DotSigned };
  /** Algorand: payment built and strictly decoded by Rust, with the live context. */
  algo: { unsigned: AlgoUnsigned; signed: AlgoSigned };
}
export type AnyUnsigned = EvmUnsigned | BtcUnsigned | SolUnsigned | TronUnsigned | XrpUnsigned | CardanoUnsigned | StellarUnsigned | NearUnsigned | SuiUnsigned | HbarUnsigned | KaspaUnsigned | DotUnsigned | AlgoUnsigned;
export type AnySigned = EvmSigned | BtcSigned | SolSigned | TronSigned | XrpSigned | CardanoSigned | StellarSigned | NearSigned | SuiSigned | HbarSigned | KaspaSigned | DotSigned | AlgoSigned;

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
  /** Extra line (Cardano: tokens moved, CIP-20 message). */
  note?: string;
  /**
   * Address-poisoning lure (packages/chains/src/poisoning.ts): `zero` = a transfer of nothing, in
   * any direction (EVM / TRON `transferFrom(you, X, 0)`, a 0-lamport Solana transfer…);
   * `notSigned` = shown as outgoing although this account did not sign the transaction. Its
   * counterparty is never a reference address.
   */
  suspect?: 'zero' | 'notSigned';
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

export type AnyAdapter =
  | ChainAdapter<'btc'>
  | ChainAdapter<'evm'>
  | ChainAdapter<'sol'>
  | ChainAdapter<'ltc'>
  | ChainAdapter<'doge'>
  | ChainAdapter<'bch'> | ChainAdapter<'dash'> | ChainAdapter<'tron'>
  | ChainAdapter<'xrp'>
  | ChainAdapter<'ada'> | ChainAdapter<'algo'> | ChainAdapter<'dot'> | ChainAdapter<'xlm'> | ChainAdapter<'near'> | ChainAdapter<'sui'> | ChainAdapter<'hbar'>
  | ChainAdapter<'kas'>;

/** The `family` tag of the unsigned transactions an adapter builds (Litecoin / Dogecoin / Bitcoin Cash / Dash: Bitcoin's PSBT shape). */
export function unsignedFamilyOf(family: Family): AnyUnsigned['family'] {
  return family === 'ltc' || family === 'doge' || family === 'bch' || family === 'dash' ? 'btc' : family;
}

/** Sign + broadcast with a union-typed adapter. */
export async function signAndBroadcast(adapter: AnyAdapter, unsigned: AnyUnsigned, password: string): Promise<string> {
  if (unsignedFamilyOf(adapter.family) !== unsigned.family) throw new Error(l10n('Famille de transaction incohérente', 'Inconsistent transaction family'));
  const a = adapter as ChainAdapter<Family>;
  const signed = await a.signTx(unsigned as never, password);
  return a.broadcast(signed as never);
}

export type { EvmTxSummary };

/** `{ account }` for a vault command, or nothing for account 0 (the call stays exactly as before). */
export function accountArg(account: number | undefined): { account?: number } {
  return account ? { account } : {};
}
