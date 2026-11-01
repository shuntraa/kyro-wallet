// SPDX-License-Identifier: GPL-3.0-or-later
//
// Aptos adapter (APT). Thin on purpose: reads, transfer building (sequence number, gas price,
// simulated max gas, expiration filled by Rust, BCS encoded by wallet-core), signature and
// submission are Rust commands (`aptos_*`, docs/IPC.md §2.11). This adapter only validates input
// and checks that what Rust built is what was asked (recipient, amount, function).

import { accountArg } from '../types';
import { call, l10n, type AptosAccountInfo, type AptosContext, type AptosHistoryEntry, type AptosTxSummary, type AptosWarning } from '@kyro/shared';
import type { AptosChain } from '../registry';
import type { HwSigner } from '../hw';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';

export type { AptosAccountInfo, AptosContext, AptosHistoryEntry, AptosTxSummary, AptosWarning };

export const APTOS_TRANSFER_FUNCTION = '0x1::aptos_account::transfer';
/** Rough gas units of a transfer that creates the recipient's account (UI hint only). */
export const APT_NEW_ACCOUNT_GAS_HINT = 1_000;

export interface AptosBackend {
  account(address: string): Promise<AptosAccountInfo>;
  txs(address: string): Promise<AptosHistoryEntry[]>;
  build(to: string, amount: string): Promise<{ raw: string; summary: AptosTxSummary; context: AptosContext }>;
  sign(raw: string, password: string): Promise<{ signed: string; hash: string; summary: AptosTxSummary; context: AptosContext }>;
  broadcast(signed: string): Promise<string>;
  txStatus(hash: string): Promise<{ committed: boolean; success: boolean; vmStatus: string }>;
}

/** The typed `aptos_*` commands of `@kyro/shared` (docs/IPC.md §2.11), for vault account `account`. */
export function rustAptosBackend(account = 0): AptosBackend {
  const acct = accountArg(account);
  return {
    account: (address) => call('aptos_account', { address }),
    txs: (address) => call('aptos_txs', { address }),
    build: (to, amount) => call('aptos_build_tx', { to, amount, ...acct }),
    sign: (raw, password) => call('aptos_sign_tx', { raw, password, ...acct }),
    broadcast: (signed) => call('aptos_broadcast', { signed, ...acct }),
    txStatus: (hash) => call('aptos_tx_status', { hash }),
  };
}

/**
 * Ledger account `accountId` (docs/IPC.md §2.3): build and broadcast for its address, signature
 * on the device (`hw_*` commands). `sign`'s second argument is the device id, not a password.
 */
export function rustAptosHwBackend(accountId: string): AptosBackend {
  return {
    ...rustAptosBackend(),
    build: (to, amount) => call('hw_aptos_build_tx', { accountId, to, amount }),
    sign: (raw, id) => call('hw_sign_aptos_tx', { id, accountId, raw }),
    broadcast: (signed) => call('hw_aptos_broadcast', { accountId, signed }),
  };
}

// ---------------------------------------------------------------- addresses

/**
 * Full `0x` + 64 hex (AIP-40 long form), the only form Rust accepts. Aptos addresses have no
 * checksum: any 64 hex characters are a valid address, so a typo sends elsewhere.
 */
export function isAptosAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(address.trim());
}

/** Why an input is not a usable Aptos address (null = usable). Same rules as Rust. */
export function aptosAddressProblem(address: string): string | null {
  const a = address.trim();
  if (a === '') return null;
  if (a.endsWith('.apt')) return l10n('Les noms ANS (.apt) ne sont pas pris en charge : colle l’adresse 0x… complète.', 'ANS names (.apt) are not supported: paste the full 0x… address.');
  if (!a.startsWith('0x')) return l10n('Une adresse Aptos commence par 0x.', 'An Aptos address starts with 0x.');
  const h = a.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(h)) return l10n('Caractère non hexadécimal dans l’adresse.', 'Non-hexadecimal character in the address.');
  if (h.length < 64) return l10n(`Forme courte (${h.length} caractères après 0x) : demande l’adresse complète de 64 caractères. Kyro ne complète pas les zéros lui-même.`, `Short form (${h.length} characters after 0x): ask for the full 64-character address. Kyro does not pad the zeros itself.`);
  if (h.length > 64) return l10n('Adresse trop longue : 64 caractères hexadécimaux après 0x.', 'Address too long: 64 hexadecimal characters after 0x.');
  return null;
}

const norm = (a: string) => a.trim().toLowerCase();

// ---------------------------------------------------------------- adapter

export interface AptosUnsigned {
  family: 'apt';
  /** Hex BCS `RawTransaction`: what Rust decodes and signs. */
  raw: string;
  summary: AptosTxSummary;
  context: AptosContext;
  recipient: string;
  /** Octas. */
  amount: bigint;
  /** maxGasAmount × gasUnitPrice (octas): reserved up front, mostly not spent. */
  maxFee: bigint;
  /** ≈ simulated gas × gas price (octas). */
  estimatedFee: bigint;
  size: { family: 'apt' };
}

export interface AptosSigned {
  family: 'apt';
  signed: string;
  hash: string;
  summary: AptosTxSummary;
}

export interface AptosAdapterOptions {
  chain: AptosChain;
  address: string;
  backend?: AptosBackend;
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
  /** Hardware-wallet account (Ledger): signing through `hw_sign_*` (`signTxHw`). */
  hw?: HwSigner;
}

export class AptosAdapter implements ChainAdapter<'apt'> {
  readonly family = 'apt' as const;
  readonly chain: AptosChain;
  private readonly address: string;
  readonly hw: HwSigner | null;
  private readonly backend: AptosBackend;

  constructor(opts: AptosAdapterOptions) {
    if (!isAptosAddress(opts.address)) throw new Error(l10n('Adresse Aptos invalide', 'Invalid Aptos address'));
    this.chain = opts.chain;
    this.address = norm(opts.address);
    this.hw = opts.hw ?? null;
    this.backend = opts.backend ?? (opts.hw ? rustAptosHwBackend(opts.hw.accountId) : rustAptosBackend(opts.account ?? 0));
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return isAptosAddress(address);
  }

  account(): Promise<AptosAccountInfo> {
    return this.backend.account(this.address);
  }

  /** Recipient facts the Send screen shows (new account?). */
  recipientInfo(address: string): Promise<AptosAccountInfo> {
    return this.backend.account(norm(address));
  }

  async getBalance(): Promise<Balance[]> {
    const acc = await this.backend.account(this.address);
    return [{ assetId: 'apt', amount: BigInt(acc.balance) }];
  }

  /** No fee to choose: Rust uses the node's gas price and a simulated maximum gas. */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'apt' as const };
    const eta = this.chain.blockTimeSecs;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: l10n('frais fixés par le réseau (≈ 0,0001 APT)', 'fees set by the network (≈ 0.0001 APT)'),
      fetchedAt: Date.now(),
    });
  }

  /**
   * `max`: balance minus the maximum fee (the network reserves max gas × price up front, so the
   * whole balance can never be sent), built twice like XRP.
   */
  async buildTx(params: BuildParams): Promise<AptosUnsigned> {
    if (params.asset.kind !== 'native') throw new Error(l10n('Actif Aptos inattendu', 'Unexpected Aptos asset'));
    if (!params.max) return this.buildTransfer(params.to, params.amount);
    const balance = BigInt((await this.backend.account(this.address)).balance);
    // First pass with room for a large fee (0.01 APT), then exactly balance − max fee.
    const first = await this.buildTransfer(params.to, balance - 1_000_000n).catch(() => null);
    const fee = first ? first.maxFee : 1_000_000n;
    const amount = balance - fee;
    if (amount <= 0n) throw new Error(l10n('Rien à envoyer : ton solde ne couvre pas les frais maximum', 'Nothing to send: your balance does not cover the maximum fee'));
    return this.buildTransfer(params.to, amount);
  }

  async buildTransfer(toInput: string, amount: bigint): Promise<AptosUnsigned> {
    const to = norm(toInput);
    const problem = aptosAddressProblem(to);
    if (problem || !isAptosAddress(to)) throw new Error(problem ?? l10n('Adresse Aptos invalide', 'Invalid Aptos address'));
    if (to === this.address) throw new Error(l10n('Envoi à soi-même impossible', 'Cannot send to yourself'));
    if (amount <= 0n) throw new Error(l10n('Montant invalide', 'Invalid amount'));
    const built = await this.backend.build(to, amount.toString());
    const s = built.summary;
    if (
      norm(s.recipient) !== to ||
      norm(s.sender) !== this.address ||
      s.amount !== amount.toString() ||
      s.function !== APTOS_TRANSFER_FUNCTION ||
      s.chainId !== this.chain.chainId ||
      s.requiresExtraConfirmation
    ) {
      throw new Error(l10n('Le transfert construit par Rust ne correspond pas à la demande', 'The transfer built by Rust does not match the request'));
    }
    return {
      family: 'apt',
      raw: built.raw,
      summary: s,
      context: built.context,
      recipient: to,
      amount,
      maxFee: BigInt(s.maxFee),
      estimatedFee: BigInt(built.context.gasUsed) * BigInt(s.gasUnitPrice),
      size: { family: 'apt' },
    };
  }

  /** Ledger: same checks as `signTx`; Rust re-reads the key, shows its dialog, then the device signs. */
  signTxHw(unsigned: AptosUnsigned, deviceId: string): Promise<AptosSigned> {
    if (!this.hw) return Promise.reject(new Error(l10n('Ce compte n’est pas un hardware wallet', 'This account is not a hardware wallet')));
    return this.signTx(unsigned, deviceId);
  }

  /** Rust: live checks (sequence, balance, re-simulation), native dialog, signature. */
  async signTx(unsigned: AptosUnsigned, password: string): Promise<AptosSigned> {
    const res = await this.backend.sign(unsigned.raw, password);
    if (!/^0x[0-9a-f]{64}$/i.test(res.hash)) throw new Error(l10n('Hash Aptos inattendu', 'Unexpected Aptos hash'));
    return { family: 'apt', signed: res.signed, hash: res.hash, summary: res.summary };
  }

  /** Rust verifies the signature and that the node's hash is ours. */
  async broadcast(signed: AptosSigned): Promise<string> {
    const hash = await this.backend.broadcast(signed.signed);
    if (hash.toLowerCase() !== signed.hash.toLowerCase()) throw new Error(l10n('Hash diffusé inattendu', 'Unexpected broadcast hash'));
    return hash;
  }

  txStatus(hash: string): Promise<{ committed: boolean; success: boolean; vmStatus: string }> {
    return this.backend.txStatus(hash);
  }

  async getHistory(): Promise<HistoryItem[]> {
    const list = await this.backend.txs(this.address);
    return list.map((t) => {
      const amount = BigInt(t.amount || '0');
      const item: HistoryItem = {
        id: t.hash ?? `aptos-v${t.version}`,
        chainKey: this.chain.key,
        assetId: 'apt',
        direction: t.direction,
        amount,
        status: t.success ? 'confirmed' : 'failed',
        kind: t.function === APTOS_TRANSFER_FUNCTION || t.function === null ? 'transfer' : 'contract',
      };
      if (t.sentByUs) item.fee = BigInt(t.fee || '0');
      if (t.counterparty) item.counterparty = t.counterparty;
      if (t.time) item.time = t.time;
      // A transfer of nothing, or shown as outgoing without our signature: poisoning lures.
      if (amount === 0n && t.direction !== 'self') item.suspect = 'zero';
      else if (t.direction === 'out' && !t.sentByUs) item.suspect = 'notSigned';
      return item;
    });
  }
}
