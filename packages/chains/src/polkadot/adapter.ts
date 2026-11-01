// SPDX-License-Identifier: GPL-3.0-or-later
//
// Polkadot adapter (DOT on Polkadot Asset Hub, WND on Westend Asset Hub). Thin on purpose:
// reads, transfer building (nonce, era, runtime checked against the metadata, all by Rust,
// encoded by wallet-core), signature and `author_submitExtrinsic` are Rust commands (`dot_*`,
// docs/IPC.md §2.11). This adapter only validates input and checks that what Rust built is
// what was asked (recipient, amount, our account).
//
// History: none. Substrate nodes do not index transfers by account and the public indexers
// (Subscan…) require an API key; the UI says so instead of showing an empty list as « no
// transaction ».

import { accountArg } from '../types';
import { call, type DotAccountInfo, type DotContext, type DotTxSummary } from '@kyro/shared';
import type { PolkadotChain } from '../registry';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';

export type { DotAccountInfo, DotContext, DotTxSummary };

export type DotTxState = 'pending' | 'finalized' | 'expired';

export interface DotBackend {
  account(address: string): Promise<DotAccountInfo>;
  build(to: string, amount: string): Promise<{ payload: string; summary: DotTxSummary; context: DotContext }>;
  sign(payload: string, password: string): Promise<{ extrinsic: string; hash: string; blockHash: string; summary: DotTxSummary; context: DotContext }>;
  broadcast(extrinsic: string, blockHash: string): Promise<string>;
  txStatus(address: string, nonce: number, validUntil: number): Promise<{ state: DotTxState; finalized: number }>;
}

/** The typed `dot_*` commands of `@kyro/shared` (docs/IPC.md §2.11), for vault account `account`. */
export function rustDotBackend(account = 0): DotBackend {
  const acct = accountArg(account);
  return {
    account: (address) => call('dot_account', { address }),
    build: (to, amount) => call('dot_build_tx', { to, amount, ...acct }),
    sign: (payload, password) => call('dot_sign_tx', { payload, password, ...acct }),
    broadcast: (extrinsic, blockHash) => call('dot_broadcast', { extrinsic, blockHash, ...acct }),
    txStatus: (address, nonce, validUntil) => call('dot_tx_status', { address, nonce, validUntil }),
  };
}

// ---------------------------------------------------------------- addresses

/**
 * SS58 address shape of the network: prefix 0 (Polkadot, « 1… ») on mainnet, 42 (generic,
 * « 5… ») on Westend; base58, 47–48 characters. The checksum and prefix are verified by Rust
 * (`dot_account_id`) on every command.
 */
export function isDotAddress(address: string, network: 'mainnet' | 'testnet'): boolean {
  const a = address.trim();
  const first = network === 'mainnet' ? '1' : '5';
  return a.startsWith(first) && /^[1-9A-HJ-NP-Za-km-z]{46,48}$/.test(a);
}

/** Why an address that looks like SS58 is not for this network (null = fine or not SS58). */
export function dotAddressProblem(address: string, network: 'mainnet' | 'testnet'): string | null {
  const a = address.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{46,48}$/.test(a) || isDotAddress(a, network)) return null;
  if (network === 'mainnet' && a.startsWith('5')) return 'Adresse au format générique (« 5… ») : demande l’adresse Polkadot (« 1… ») du destinataire, ou convertis-la (même compte, préfixe 0).';
  if (network === 'testnet' && a.startsWith('1')) return 'Adresse Polkadot mainnet (« 1… ») : sur Westend, Kyro attend le format générique (« 5… »).';
  return 'Adresse d’un autre réseau Substrate (Kusama ou autre) : refusée.';
}

// ---------------------------------------------------------------- adapter

export interface DotUnsigned {
  family: 'dot';
  /** Signing payload, hex: what Rust decodes and signs. */
  payload: string;
  summary: DotTxSummary;
  context: DotContext;
  recipient: string;
  /** Planck. */
  amount: bigint;
  /** Fee estimate of the node (planck), paid on top of the amount. */
  maxFee: bigint;
  size: { family: 'dot' };
}

export interface DotSigned {
  family: 'dot';
  extrinsic: string;
  hash: string;
  /** Era block hash: signed, not in the extrinsic; `dot_broadcast` re-verifies with it. */
  blockHash: string;
  summary: DotTxSummary;
  validUntil: number;
}

export interface PolkadotAdapterOptions {
  chain: PolkadotChain;
  address: string;
  backend?: DotBackend;
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
}

export class PolkadotAdapter implements ChainAdapter<'dot'> {
  readonly family = 'dot' as const;
  readonly chain: PolkadotChain;
  private readonly address: string;
  private readonly backend: DotBackend;

  constructor(opts: PolkadotAdapterOptions) {
    if (!isDotAddress(opts.address, opts.chain.network)) throw new Error('Adresse Polkadot invalide');
    this.chain = opts.chain;
    this.address = opts.address;
    this.backend = opts.backend ?? rustDotBackend(opts.account ?? 0);
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return isDotAddress(address, this.chain.network);
  }

  account(): Promise<DotAccountInfo> {
    return this.backend.account(this.address);
  }

  /** Recipient facts the Send screen needs before building: does the account exist? */
  destinationInfo(address: string): Promise<DotAccountInfo> {
    return this.backend.account(address);
  }

  /** Free balance, plus `spendable` = free − max(frozen − reserved, existential deposit). */
  async getBalance(): Promise<Array<Balance & { spendable: bigint }>> {
    const acc = await this.backend.account(this.address);
    return [{ assetId: 'dot', amount: BigInt(acc.free), spendable: BigInt(acc.spendable) }];
  }

  /** No fee to choose: weight and length fee of the runtime, estimated by the node, no tip. */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'dot' as const };
    const eta = this.chain.blockTimeSecs * 3;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: `frais fixés par le runtime (≈ 0,015 ${this.chain.nativeSymbol}), sans pourboire`,
      fetchedAt: Date.now(),
    });
  }

  /** `max`: spendable minus the fee Rust estimates, built twice. */
  async buildTx(params: BuildParams): Promise<DotUnsigned> {
    if (params.asset.kind !== 'native') throw new Error('Actif Polkadot inattendu');
    if (!params.max) return this.buildTransfer(params.to, params.amount);
    const spendable = BigInt((await this.backend.account(this.address)).spendable);
    const unit = 10n ** BigInt(this.chain.nativeDecimals);
    // First pass with a fee ceiling of 0.1 token; then exactly spendable − fee.
    const first = await this.buildTransfer(params.to, spendable - unit / 10n).catch(() => null);
    const fee = first ? first.maxFee : unit / 10n;
    const amount = spendable - fee;
    if (amount <= 0n) throw new Error('Rien à envoyer : ton solde disponible ne couvre pas les frais (le dépôt existentiel reste sur le compte)');
    return this.buildTransfer(params.to, amount);
  }

  /** `amount` in planck. Rust re-checks existential deposit, balance and fee. */
  async buildTransfer(toInput: string, amount: bigint): Promise<DotUnsigned> {
    const to = toInput.trim();
    if (!isDotAddress(to, this.chain.network)) throw new Error(dotAddressProblem(to, this.chain.network) ?? 'Adresse Polkadot invalide');
    if (to === this.address) throw new Error('Transfert à soi-même impossible');
    if (amount <= 0n) throw new Error('Montant invalide');
    const built = await this.backend.build(to, amount.toString());
    const s = built.summary;
    if (s.to !== to || s.from !== this.address || s.amount !== amount.toString() || s.call !== 'Balances.transfer_keep_alive' || s.tip !== '0') {
      throw new Error('Le transfert construit par Rust ne correspond pas à la demande');
    }
    return {
      family: 'dot',
      payload: built.payload,
      summary: s,
      context: built.context,
      recipient: to,
      amount,
      maxFee: BigInt(built.context.fee),
      size: { family: 'dot' },
    };
  }

  /** Rust: live checks, native dialog, signature. */
  async signTx(unsigned: DotUnsigned, password: string): Promise<DotSigned> {
    const res = await this.backend.sign(unsigned.payload, password);
    if (!/^[0-9a-f]{64}$/i.test(res.hash)) throw new Error('Hash Polkadot inattendu');
    return { family: 'dot', extrinsic: res.extrinsic, hash: res.hash, blockHash: res.blockHash, summary: res.summary, validUntil: res.context.validUntil };
  }

  /** Rust verifies the signature and that the node's hash is ours. */
  async broadcast(signed: DotSigned): Promise<string> {
    const hash = await this.backend.broadcast(signed.extrinsic, signed.blockHash);
    if (hash.toLowerCase() !== signed.hash.toLowerCase()) throw new Error('Hash diffusé inattendu');
    return hash;
  }

  /** By nonce: `finalized` once used in the finalized state, `expired` after the era. */
  txStatus(nonce: number, validUntil: number): Promise<{ state: DotTxState; finalized: number }> {
    return this.backend.txStatus(this.address, nonce, validUntil);
  }

  /** No keyless public indexer: Kyro shows no history for Polkadot (see the module comment). */
  getHistory(): Promise<HistoryItem[]> {
    return Promise.resolve([]);
  }
}
