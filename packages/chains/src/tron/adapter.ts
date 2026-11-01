// SPDX-License-Identifier: GPL-3.0-or-later
//
// TRON adapter (TRX + TRC-20). Thin on purpose: every read, the transaction building, the
// signature and the broadcast are Rust commands (`tron_*`, docs/IPC.md §2.5).
// - Rust builds `raw_data` itself from the latest block (never the server's
//   `createtransaction`), simulates the energy of a TRC-20 transfer and sets `fee_limit`;
// - Rust decodes it again before signing, shows the native dialog (bandwidth / energy
//   available, TRX burned at most, activation of a new account) and signs `sha256(raw_data)`;
// - this adapter only checks that what Rust built is what was asked (recipient, amount, token).

import { accountArg } from '../types';
import * as bitcoin from 'bitcoinjs-lib';
import {
  call,
  type Network,
  type TronAccountInfo,
  type TronAction,
  type TronEstimate,
  type TronHistoryEntry,
  type TronTxSummary,
  type TronWarning, l10n } from '@kyro/shared';
import type { AssetDef, TronChain } from '../registry';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';

// ---------------------------------------------------------------- Rust contract (§2.5)

export type { TronAccountInfo, TronAction, TronEstimate, TronHistoryEntry, TronTxSummary, TronWarning };

export interface TronBackend {
  account(address: string): Promise<TronAccountInfo>;
  trc20Balance(contract: string, address: string): Promise<string>;
  txs(address: string): Promise<TronHistoryEntry[]>;
  build(to: string, amount: string, token?: string): Promise<{ raw: string; txid: string; summary: TronTxSummary; estimate: TronEstimate }>;
  sign(raw: string, password: string): Promise<{ signature: string; txid: string; summary: TronTxSummary; estimate: TronEstimate }>;
  broadcast(raw: string, signature: string): Promise<string>;
}

/** The typed `tron_*` commands of `@kyro/shared` (docs/IPC.md §2.5), for vault account `account`. */
export function rustTronBackend(account = 0): TronBackend {
  const acct = accountArg(account);
  return {
    account: (address) => call('tron_account', { address }),
    trc20Balance: (contract, address) => call('tron_trc20_balance', { contract, address }),
    txs: (address) => call('tron_txs', { address }),
    build: (to, amount, token) => call('tron_build_tx', { to, amount, ...(token ? { token } : {}), ...acct }),
    sign: (raw, password) => call('tron_sign_tx', { raw, password, ...acct }),
    broadcast: (raw, signature) => call('tron_broadcast', { raw, signature, ...acct }),
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

/** Whether Rust names this token itself in the dialog (USDT of the network); others are « non vérifié ». */
export function isKnownTronToken(network: Network, contract: string): boolean {
  return TRON_USDT[network].contract === contract;
}

/**
 * Can the TRX balance pay what this transaction burns? `sent`: TRX leaving (sun, 0 for a token).
 * - `expected`: balance covers sent + expected burn (bandwidth + activation + energy);
 * - `worst`: balance covers sent + the maximum (energy up to `fee_limit`).
 * Below `expected`, the network refuses the TRX transfer or the TRC-20 call runs out of energy
 * (and still burns TRX): the UI blocks it. Between the two, it may fail if energy costs more.
 */
export interface TronCoverage {
  expected: boolean;
  worst: boolean;
  /** Sun missing for the expected case (0n when covered). */
  missing: bigint;
  /** Sun missing for the worst case (0n when covered). */
  missingWorst: bigint;
}

export function tronCoverage(estimate: TronEstimate, sent: bigint): TronCoverage {
  const balance = BigInt(estimate.balance);
  const need = sent + BigInt(estimate.totalBurn);
  const needMax = sent + BigInt(estimate.totalBurnMax);
  return {
    expected: balance >= need,
    worst: balance >= needMax,
    missing: balance >= need ? 0n : need - balance,
    missingWorst: balance >= needMax ? 0n : needMax - balance,
  };
}

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
  /** Most TRX this may burn (sun): `estimate.totalBurnMax`. */
  maxFee: bigint;
  size: { family: 'tron'; bandwidth: number; energy: number };
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
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
}

export class TronAdapter implements ChainAdapter<'tron'> {
  readonly family = 'tron' as const;
  readonly chain: TronChain;
  readonly tokens: Trc20Token[];
  private readonly address: string;
  private readonly backend: TronBackend;

  constructor(opts: TronAdapterOptions) {
    if (!isTronAddress(opts.address)) throw new Error(l10n('Adresse TRON invalide', 'Invalid TRON address'));
    this.chain = opts.chain;
    this.address = opts.address;
    this.backend = opts.backend ?? rustTronBackend(opts.account ?? 0);
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

  async getBalance(): Promise<Balance[]> {
    const [acc, ...tokens] = await Promise.all([this.backend.account(this.address), ...this.tokens.map((t) => this.backend.trc20Balance(t.contract, this.address))]);
    return [{ assetId: tronAssetId(), amount: BigInt(acc.balance) }, ...this.tokens.map((t, i) => ({ assetId: tronAssetId(t), amount: BigInt(tokens[i] ?? '0') }))];
  }

  /** No fee to choose on TRON: Rust estimates the burn when it builds (shown before signing). */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'tron' as const };
    const eta = this.chain.blockTimeSecs;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: l10n('bande passante et énergie, estimées par Rust', 'bandwidth and energy, estimated by Rust'),
      fetchedAt: Date.now(),
    });
  }

  /** The TRC-20 token of an asset: the curated one, or (unknown contract) the asset's own metadata. */
  tokenOf(asset: AssetDef): Trc20Token | undefined {
    if (asset.kind === 'native') return undefined;
    if (asset.kind !== 'trc20' || !asset.contract || !isTronAddress(asset.contract)) throw new Error(l10n('Actif TRON inattendu', 'Unexpected TRON asset'));
    return this.tokens.find((t) => t.contract === asset.contract) ?? { contract: asset.contract, symbol: asset.symbol, name: asset.name, decimals: asset.decimals };
  }

  /**
   * `ChainAdapter` entry point. `max`: a token → its whole balance; TRX → balance minus the most
   * the transfer may burn (built twice: the burn depends on the recipient and the size).
   */
  async buildTx(params: BuildParams): Promise<TronUnsigned> {
    const token = this.tokenOf(params.asset);
    if (!params.max) return this.buildTransfer({ to: params.to, amount: params.amount, ...(token ? { token } : {}) });
    const balances = await this.getBalance();
    const held = balances.find((b) => b.assetId === tronAssetId(token))?.amount ?? 0n;
    if (token) {
      if (held <= 0n) throw new Error(l10n(`Aucun ${token.symbol} à envoyer`, `No ${token.symbol} to send`));
      return this.buildTransfer({ to: params.to, amount: held, token });
    }
    // First pass with a placeholder amount gives the burn (activation, bandwidth) for this recipient.
    const probe = await this.buildTransfer({ to: params.to, amount: held > 1n ? held / 2n : 1n });
    let amount = held - BigInt(probe.estimate.totalBurnMax);
    if (amount <= 0n) throw new Error(l10n('Solde TRX trop faible pour couvrir les frais brûlés', 'TRX balance too low to cover the burned fees'));
    let built = await this.buildTransfer({ to: params.to, amount });
    const over = amount + BigInt(built.estimate.totalBurnMax) - held;
    if (over > 0n) {
      amount -= over;
      if (amount <= 0n) throw new Error(l10n('Solde TRX trop faible pour couvrir les frais brûlés', 'TRX balance too low to cover the burned fees'));
      built = await this.buildTransfer({ to: params.to, amount });
    }
    return built;
  }

  /**
   * Rust builds from the latest block. `amount`: sun (TRX) or token units. The adapter checks
   * that Rust's decoding is exactly the request.
   */
  async buildTransfer(params: { to: string; amount: bigint; token?: Trc20Token }): Promise<TronUnsigned> {
    const to = params.to.trim();
    if (!isTronAddress(to)) throw new Error(l10n('Adresse TRON invalide', 'Invalid TRON address'));
    if (params.amount <= 0n) throw new Error(l10n('Montant invalide', 'Invalid amount'));
    if (!params.token && to === this.address) throw new Error(l10n('TRON refuse un envoi de TRX à soi-même', 'TRON refuses sending TRX to yourself'));
    const built = await this.backend.build(to, params.amount.toString(), params.token?.contract);
    const a = built.summary.action;
    const ok = params.token
      ? a.type === 'trc20Transfer' && a.contract === params.token.contract && a.to === to && a.amount === params.amount.toString() && a.callValue === '0'
      : a.type === 'trxTransfer' && a.to === to && a.amount === params.amount.toString();
    // Kyro's own builds carry no memo, no call value, no unknown call; only a very high
    // fee_limit (huge energy) may be flagged.
    const unexpected = built.summary.warnings.some((w) => w.kind !== 'highFeeLimit');
    if (!ok || built.summary.owner !== this.address || built.summary.txid !== built.txid || unexpected) {
      throw new Error(l10n('La transaction construite par Rust ne correspond pas à la demande', 'The transaction built by Rust does not match the request'));
    }
    return {
      family: 'tron',
      raw: built.raw,
      txid: built.txid,
      summary: built.summary,
      estimate: built.estimate,
      amount: params.amount,
      recipient: to,
      ...(params.token ? { token: params.token } : {}),
      maxFee: BigInt(built.estimate.totalBurnMax),
      size: { family: 'tron', bandwidth: built.estimate.bandwidthNeeded, energy: built.estimate.energyNeeded },
    };
  }

  /** Rust: password, decoding, live resources, native dialog (+ reinforced one), signature. */
  async signTx(unsigned: TronUnsigned, password: string): Promise<TronSigned> {
    // No hint: Rust names a TRC-20 from its own table only (unknown: raw units, reinforced dialog).
    const res = await this.backend.sign(unsigned.raw, password);
    if (res.txid !== unsigned.txid || !/^[0-9a-f]{130}$/.test(res.signature)) throw new Error('Signature TRON inattendue');
    return { family: 'tron', raw: unsigned.raw, signature: res.signature, txid: res.txid, summary: res.summary, estimate: res.estimate };
  }

  /** Rust checks the signature recovers to our address and that the server's txid matches. */
  async broadcast(signed: TronSigned): Promise<string> {
    const txid = await this.backend.broadcast(signed.raw, signed.signature);
    if (txid !== signed.txid) throw new Error(l10n('txid diffusé inattendu', 'Unexpected broadcast txid'));
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
      // TronGrid's TRC-20 list gives the EVENT's from/to, not who signed: `transferFrom(you, X, 0)`
      // appears as « sent by you ». A zero amount is a lure in either direction (poisoning.ts);
      // outgoing entries are never trusted anyway (only sends signed by this device are).
      if (item.amount === 0n) item.suspect = 'zero';
      if (t.timestamp) item.time = t.timestamp;
      return item;
    });
  }
}
