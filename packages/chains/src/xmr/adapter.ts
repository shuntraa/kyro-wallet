// SPDX-License-Identifier: GPL-3.0-or-later
//
// Monero adapter (XMR). Thin on purpose: Rust scans the blocks itself (the node never receives a
// key, view key included), keeps the encrypted scan state, picks the inputs, fetches the decoys
// and the fee rate, builds, signs AND publishes the transfer (`xmr_*`, docs/IPC.md §2.11). This
// adapter only checks the input shape and that what Rust built is what was asked (destination,
// amount). The transfer itself never leaves Rust: the UI only holds a handle (`id`).

import { accountArg } from '../types';
import { call, l10n, type XmrDestination, type XmrHistoryEntry, type XmrStatus, type XmrSubaddress, type XmrTxSummary, type XmrWarning } from '@kyro/shared';
import type { XmrChain } from '../registry';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';

export type { XmrDestination, XmrHistoryEntry, XmrStatus, XmrSubaddress, XmrTxSummary, XmrWarning };

/** 1 XMR = 10^12 piconero. */
export const XMR_DECIMALS = 12;
/** Blocks before a received output can be spent (protocol rule). */
export const XMR_LOCK_BLOCKS = 10;

// ---------------------------------------------------------------- Rust contract (§2.11)

export interface XmrBackend {
  status(): Promise<XmrStatus>;
  sync(): Promise<XmrStatus>;
  txs(): Promise<XmrHistoryEntry[]>;
  subaddresses(): Promise<XmrSubaddress[]>;
  newSubaddress(): Promise<XmrSubaddress>;
  validate(address: string): Promise<XmrDestination>;
  setRestoreHeight(height: number): Promise<XmrStatus>;
  prepare(to: string, amount?: string): Promise<{ id: string; summary: XmrTxSummary }>;
  send(id: string, password: string): Promise<{ txid: string; summary: XmrTxSummary }>;
  showSeed(password: string): Promise<void>;
}

/** The typed `xmr_*` commands of `@kyro/shared`, for vault account `account`. */
export function rustXmrBackend(account = 0): XmrBackend {
  const acct = accountArg(account);
  return {
    status: () => call('xmr_status', acct),
    sync: () => call('xmr_sync', acct),
    txs: () => call('xmr_txs', acct),
    subaddresses: () => call('xmr_subaddresses', acct),
    newSubaddress: () => call('xmr_new_subaddress', acct),
    validate: (address) => call('xmr_validate_address', { address }),
    setRestoreHeight: (height) => call('xmr_set_restore_height', { height, ...acct }),
    prepare: (to, amount) => call('xmr_prepare_tx', { to, ...(amount !== undefined ? { amount } : {}), ...acct }),
    send: (id, password) => call('xmr_send_tx', { id, password, ...acct }),
    showSeed: (password) => call('xmr_seed_show', { password, ...acct }),
  };
}

// ---------------------------------------------------------------- addresses

const XMR_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Shape of a Monero address (Monero base58, 95 characters; integrated: 106). Mainnet: `4…`
 * (standard / integrated) or `8…` (subaddress); stagenet: `5…` or `7…`. The checksum, the
 * network and the kind are decoded by Rust (`xmr_validate_address`, wallet-core) before anything.
 */
export function isXmrAddress(address: string, network: 'mainnet' | 'testnet' = 'mainnet'): boolean {
  const a = address.trim();
  if (![...a].every((c) => XMR_ALPHABET.includes(c))) return false;
  const [std, sub] = network === 'mainnet' ? ['4', '8'] : ['5', '7'];
  if (a.length === 95) return a.startsWith(std) || a.startsWith(sub);
  if (a.length === 106) return a.startsWith(std);
  return false;
}

/** French label of a destination kind (Rust's decoding). */
export function xmrDestinationLabel(d: XmrDestination): string {
  switch (d.kind) {
    case 'standard':
      return l10n('Adresse standard', 'Standard address');
    case 'subaddress':
      return l10n('Sous-adresse', 'Subaddress');
    case 'integrated':
      return l10n(`Adresse intégrée (ID de paiement ${d.paymentId})`, `Integrated address (payment ID ${d.paymentId})`);
  }
}

/** Approximate block height at UNIX time `date` (2 min per block), from the node's tip. */
export function xmrHeightAt(date: number, tip: number, tipTime: number): number {
  const back = Math.max(0, Math.ceil((tipTime - date) / 120));
  return Math.max(0, tip - back);
}

// ---------------------------------------------------------------- adapter

export interface XmrUnsigned {
  family: 'xmr';
  /** Handle of the transfer kept by Rust (10 min). */
  id: string;
  summary: XmrTxSummary;
  recipient: string;
  /** Piconero sent. */
  amount: bigint;
  /** Fee set by Rust (piconero). */
  maxFee: bigint;
  size: { family: 'xmr' };
}

/** Rust signs AND publishes in `xmr_send_tx`: `broadcast` only returns this txid. */
export interface XmrSigned {
  family: 'xmr';
  txid: string;
  summary: XmrTxSummary;
}

export interface XmrAdapterOptions {
  chain: XmrChain;
  /** Primary address (`accounts_get().xmr.address`). */
  address: string;
  backend?: XmrBackend;
  /** Vault account passed to every command; absent = 0. */
  account?: number;
}

export class XmrAdapter implements ChainAdapter<'xmr'> {
  readonly family = 'xmr' as const;
  readonly chain: XmrChain;
  private readonly address: string;
  readonly backend: XmrBackend;

  constructor(opts: XmrAdapterOptions) {
    if (!isXmrAddress(opts.address, opts.chain.network)) throw new Error(l10n('Adresse Monero invalide', 'Invalid Monero address'));
    this.chain = opts.chain;
    this.address = opts.address;
    this.backend = opts.backend ?? rustXmrBackend(opts.account ?? 0);
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return isXmrAddress(address, this.chain.network);
  }

  status(): Promise<XmrStatus> {
    return this.backend.status();
  }

  /** Starts the background scan (no-op if one runs). */
  sync(): Promise<XmrStatus> {
    return this.backend.sync();
  }

  /**
   * Balance = everything not spent; `spendable` = unlocked (10 confirmations). An account already
   * scanned once (restore height set) is brought up to date in the background; a never-used one is
   * only scanned once its Monero screen is opened (no block download for a user without XMR).
   */
  async getBalance(): Promise<Array<Balance & { spendable: bigint }>> {
    let s = await this.backend.status();
    if (s.restoreHeight !== null && !s.running) s = await this.backend.sync().catch(() => s);
    return [{ assetId: 'xmr', amount: BigInt(s.balance), spendable: BigInt(s.unlocked) }];
  }

  /** No fee to choose: Rust takes the node's « normal » estimate (bounded) and the exact weight. */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'xmr' as const };
    const eta = this.chain.blockTimeSecs;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: l10n('frais calculés par Rust (≈ 0,0001 XMR)', 'fee computed by Rust (≈ 0.0001 XMR)'),
      fetchedAt: Date.now(),
    });
  }

  /** Rust picks the inputs, decoys, fee and change. `max`: everything unlocked, minus the fee. */
  async buildTx(params: BuildParams): Promise<XmrUnsigned> {
    if (params.asset.kind !== 'native') throw new Error(l10n('Actif Monero inattendu', 'Unexpected Monero asset'));
    const to = params.to.trim();
    if (!isXmrAddress(to, this.chain.network)) throw new Error(l10n('Adresse Monero invalide', 'Invalid Monero address'));
    if (!params.max && params.amount <= 0n) throw new Error(l10n('Montant invalide', 'Invalid amount'));
    const built = await this.backend.prepare(to, params.max ? undefined : params.amount.toString());
    const s = built.summary;
    const network = this.chain.network === 'mainnet' ? 'mainnet' : 'stagenet';
    if (s.destination.address !== to || s.network !== network || (!params.max && s.amount !== params.amount.toString())) {
      throw new Error(l10n('Le transfert construit par Rust ne correspond pas à la demande', 'The transfer built by Rust does not match the request'));
    }
    return { family: 'xmr', id: built.id, summary: s, recipient: to, amount: BigInt(s.amount), maxFee: BigInt(s.fee), size: { family: 'xmr' } };
  }

  /** Rust: native dialog, signature, checks, publication. */
  async signTx(unsigned: XmrUnsigned, password: string): Promise<XmrSigned> {
    const res = await this.backend.send(unsigned.id, password);
    if (!/^[0-9a-f]{64}$/i.test(res.txid)) throw new Error(l10n('Identifiant de transaction Monero inattendu', 'Unexpected Monero transaction ID'));
    return { family: 'xmr', txid: res.txid, summary: res.summary };
  }

  /** Already published by `xmr_send_tx`. */
  broadcast(signed: XmrSigned): Promise<string> {
    return Promise.resolve(signed.txid);
  }

  async getHistory(): Promise<HistoryItem[]> {
    const list = await this.backend.txs();
    return list.map((t) => {
      const item: HistoryItem = {
        id: t.txid,
        chainKey: this.chain.key,
        assetId: 'xmr',
        direction: t.direction,
        amount: BigInt(t.amount),
        status: t.height === 0 ? 'pending' : 'confirmed',
        kind: 'transfer',
        time: t.time * 1000,
      };
      if (t.fee !== null && t.direction !== 'in') item.fee = BigInt(t.fee);
      if (t.to) item.counterparty = t.to;
      if (t.height > 0 && t.confirmations < XMR_LOCK_BLOCKS && t.direction === 'in') item.note = l10n(`${t.confirmations}/${XMR_LOCK_BLOCKS} confirmations : encore bloqué`, `${t.confirmations}/${XMR_LOCK_BLOCKS} confirmations: still locked`);
      return item;
    });
  }
}
