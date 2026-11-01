// SPDX-License-Identifier: GPL-3.0-or-later
//
// Algorand adapter (ALGO payments). Thin on purpose: reads, payment building (fee, validity
// window and genesis filled by Rust, canonical msgpack encoded by wallet-core), signature and
// submission are Rust commands (`algo_*`, docs/IPC.md §2.11). This adapter only validates input
// and checks that what Rust built is what was asked (receiver, amount, note).

import {
  call,
  l10n,
  isAlgoAddress,
  type AlgoAccountInfo,
  type AlgoBuilt,
  type AlgoContext,
  type AlgoHistoryEntry,
  type AlgoHolding,
  type AlgoTxStatus,
  type AlgoTxSummary,
  type AlgoWarning,
} from '@kyro/shared';
import { accountArg } from '../types';
import { ALGO_ASSETS, type AlgorandChain } from '../registry';
import type { HwSigner } from '../hw';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';

export type { AlgoAccountInfo, AlgoContext, AlgoHistoryEntry, AlgoHolding, AlgoTxStatus, AlgoTxSummary, AlgoWarning };

/** 0.1 ALGO: minimum balance of an account (each asset opted in adds 0.1 ALGO). */
export const ALGO_MIN_BALANCE = 100_000n;
/** Protocol maximum note size, bytes. */
export const ALGO_MAX_NOTE = 1024;

export interface AlgoBackend {
  account(address: string): Promise<AlgoAccountInfo>;
  txs(address: string): Promise<AlgoHistoryEntry[]>;
  build(to: string, amount: string, note?: string): Promise<AlgoBuilt>;
  sign(blob: string, password: string): Promise<{ blob: string; txid: string; summary: AlgoTxSummary; context: AlgoContext }>;
  broadcast(blob: string): Promise<string>;
  txStatus(txid: string): Promise<AlgoTxStatus>;
  /** Tokens (ASA, known ids only); optional so that test backends and hardware wallets can leave them out. */
  holdings?(address: string): Promise<AlgoHolding[]>;
  buildOptIn?(assetId: number): Promise<AlgoBuilt>;
  buildAsset?(assetId: number, to: string, amount: string, note?: string): Promise<AlgoBuilt>;
}

/** The typed `algo_*` commands of `@kyro/shared` (docs/IPC.md §2.11), for vault account `account`. */
export function rustAlgoBackend(account = 0): AlgoBackend {
  const acct = accountArg(account);
  return {
    account: (address) => call('algo_account', { address }),
    txs: (address) => call('algo_txs', { address }),
    build: (to, amount, note) => call('algo_build_tx', { to, amount, ...(note ? { note } : {}), ...acct }),
    sign: (blob, password) => call('algo_sign_tx', { blob, password, ...acct }),
    broadcast: (blob) => call('algo_broadcast', { blob, ...acct }),
    txStatus: (txid) => call('algo_tx_status', { txid }),
    holdings: (address) => call('algo_asset_holdings', { address }),
    buildOptIn: (assetId) => call('algo_build_optin_tx', { assetId, ...acct }),
    buildAsset: (assetId, to, amount, note) => call('algo_build_asset_tx', { assetId, to, amount, ...(note ? { note } : {}), ...acct }),
  };
}

/**
 * Ledger account `accountId` (docs/IPC.md §2.3): build and broadcast for its address, signature
 * on the device (`hw_*` commands). `sign`'s second argument is the device id, not a password.
 */
export function rustAlgoHwBackend(accountId: string): AlgoBackend {
  const base = rustAlgoBackend();
  // Tokens are not signed on a hardware wallet yet (holdings stay readable).
  delete base.buildOptIn;
  delete base.buildAsset;
  return {
    ...base,
    build: (to, amount, note) => call('hw_algo_build_tx', { accountId, to, amount, ...(note ? { note } : {}) }),
    sign: (blob, id) => call('hw_sign_algo_tx', { id, accountId, blob }),
    broadcast: (blob) => call('hw_algo_broadcast', { accountId, blob }),
  };
}

/**
 * Algorand address: 58 upper-case base32 characters = public key ‖ last 4 bytes of
 * SHA-512/256(key) (`@kyro/shared`). Checked here for the UI; Rust checks again on every command.
 */
export { isAlgoAddress };

/** Size of a note in bytes (UTF-8), what the 1024-byte limit counts. */
export function algoNoteBytes(note: string): number {
  return new TextEncoder().encode(note).length;
}

export interface AlgoUnsigned {
  family: 'algo';
  blob: string;
  summary: AlgoTxSummary;
  context: AlgoContext;
  recipient: string;
  /** µALGO (token: its base units). */
  amount: bigint;
  note?: string;
  /** Fee set by Rust (µALGO): the whole cost on top of the amount. */
  maxFee: bigint;
  size: { family: 'algo' };
}

export interface AlgoSigned {
  family: 'algo';
  blob: string;
  txid: string;
  summary: AlgoTxSummary;
}

export interface AlgorandAdapterOptions {
  chain: AlgorandChain;
  address: string;
  backend?: AlgoBackend;
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
  /** Hardware-wallet account (Ledger): signing through `hw_sign_*` (`signTxHw`). */
  hw?: HwSigner;
}

export class AlgorandAdapter implements ChainAdapter<'algo'> {
  readonly family = 'algo' as const;
  readonly chain: AlgorandChain;
  private readonly address: string;
  readonly hw: HwSigner | null;
  private readonly backend: AlgoBackend;

  constructor(opts: AlgorandAdapterOptions) {
    if (!isAlgoAddress(opts.address)) throw new Error(l10n('Adresse Algorand invalide', 'Invalid Algorand address'));
    this.chain = opts.chain;
    this.address = opts.address;
    this.hw = opts.hw ?? null;
    this.backend = opts.backend ?? (opts.hw ? rustAlgoHwBackend(opts.hw.accountId) : rustAlgoBackend(opts.account ?? 0));
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return isAlgoAddress(address);
  }

  account(): Promise<AlgoAccountInfo> {
    return this.backend.account(this.address);
  }

  /** Receiver facts the Send screen needs before building: does it exist (≥ 0.1 ALGO needed)? */
  destinationInfo(address: string): Promise<AlgoAccountInfo> {
    return this.backend.account(address);
  }

  /** ALGO balance, plus `spendable` = balance − minimum balance (what can actually be sent); then the known tokens enabled. */
  async getBalance(): Promise<Array<Balance & { spendable: bigint }>> {
    const acc = await this.backend.account(this.address);
    const out = [{ assetId: 'algo', amount: BigInt(acc.balance), spendable: BigInt(acc.spendable) }];
    if (acc.exists) {
      for (const h of await this.holdings()) {
        if (h.optedIn && /^\d+$/.test(h.amount)) out.push({ assetId: `asa:${h.assetId}`, amount: BigInt(h.amount), spendable: h.frozen ? 0n : BigInt(h.amount) });
      }
    }
    return out;
  }

  /** Known tokens of the network (USDC, USD₮), in registry order. */
  knownAssets() {
    return ALGO_ASSETS[this.chain.network];
  }

  /** Holdings of the known tokens (an asset id the backend answers for but Kyro does not know is dropped). */
  async holdings(address = this.address): Promise<AlgoHolding[]> {
    if (!this.backend.holdings || !this.knownAssets().length) return [];
    const known = new Set(this.knownAssets().map((k) => Number(k.contract)));
    return (await this.backend.holdings(address)).filter((h) => known.has(h.assetId));
  }

  /** Tokens can be enabled and sent from this account (not on a hardware wallet yet). */
  get tokensSignable(): boolean {
    return !!this.backend.buildOptIn && !!this.backend.buildAsset;
  }

  /** Opt-in to a known token: 0-unit transfer to ourselves, +0.1 ALGO of minimum balance. Signed with `signTx`. */
  async buildOptIn(assetId: number): Promise<AlgoUnsigned> {
    const k = this.knownAssets().find((x) => Number(x.contract) === assetId);
    if (!k || !this.backend.buildOptIn) throw new Error(l10n('Jeton Algorand inconnu', 'Unknown Algorand token'));
    const built = await this.backend.buildOptIn(assetId);
    const s = built.summary;
    const a = s.asset;
    if (!a || !a.optIn || a.assetId !== assetId || a.decimals !== k.decimals || a.amount !== '0' || s.sender !== this.address || s.receiver !== this.address || s.amount !== '0' || s.noteLen !== 0 || s.warnings.length) {
      throw new Error(l10n('L’activation construite par Rust ne correspond pas à la demande', 'The opt-in built by Rust does not match the request'));
    }
    return { family: 'algo', blob: built.blob, summary: s, context: built.context, recipient: this.address, amount: 0n, maxFee: BigInt(s.fee), size: { family: 'algo' } };
  }

  /** Token transfer (base units); Rust re-checks both holdings (opt-in, frozen) and the ALGO for the fee. */
  private async buildAssetTx(params: BuildParams): Promise<AlgoUnsigned> {
    const k = this.knownAssets().find((x) => `asa:${x.contract}` === params.asset.id);
    if (!k || k.decimals !== params.asset.decimals || !this.backend.buildAsset) throw new Error(l10n('Jeton Algorand inconnu', 'Unknown Algorand token'));
    const assetId = Number(k.contract);
    const to = params.to.trim();
    if (!isAlgoAddress(to)) throw new Error(l10n('Adresse Algorand invalide (58 caractères A–Z, 2–7)', 'Invalid Algorand address (58 characters A–Z, 2–7)'));
    if (to === this.address) throw new Error(l10n('Envoi à soi-même impossible', 'Sending to yourself is not possible'));
    let amount = params.amount;
    if (params.max === true) {
      const h = (await this.holdings()).find((x) => x.assetId === assetId);
      amount = h ? BigInt(h.amount) : 0n;
    }
    if (amount <= 0n) throw new Error(l10n('Montant invalide', 'Invalid amount'));
    const note = params.memo?.trim() ?? '';
    if (algoNoteBytes(note) > ALGO_MAX_NOTE) throw new Error(l10n('Note trop longue (1024 octets au plus)', 'Note too long (1024 bytes at most)'));
    const built = await this.backend.buildAsset(assetId, to, amount.toString(), note || undefined);
    const s = built.summary;
    const a = s.asset;
    const noteOk = note ? s.noteLen === algoNoteBytes(note) && s.noteText === note : s.noteLen === 0;
    const extraOk = s.warnings.every((w) => w.kind === 'note' && note !== '');
    if (!a || a.optIn || a.assetId !== assetId || a.decimals !== k.decimals || a.amount !== amount.toString() || s.receiver !== to || s.sender !== this.address || s.amount !== '0' || !noteOk || !extraOk) {
      throw new Error(l10n('Le transfert construit par Rust ne correspond pas à la demande', 'The transfer built by Rust does not match the request'));
    }
    return { family: 'algo', blob: built.blob, summary: s, context: built.context, recipient: to, amount, ...(note ? { note } : {}), maxFee: BigInt(s.fee), size: { family: 'algo' } };
  }

  /** No fee to choose: Rust sets the protocol minimum (0.001 ALGO), more only under congestion. */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'algo' as const };
    const eta = this.chain.blockTimeSecs;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: l10n('frais fixés par le protocole (0,001 ALGO)', 'fee set by the protocol (0.001 ALGO)'),
      fetchedAt: Date.now(),
    });
  }

  /** `ChainAdapter` entry point. `max`: spendable (balance − minimum balance) minus the fee Rust sets. */
  async buildTx(params: BuildParams): Promise<AlgoUnsigned> {
    if (params.asset.kind === 'asa') return this.buildAssetTx(params);
    if (params.asset.kind !== 'native') throw new Error(l10n('Actif Algorand inattendu', 'Unexpected Algorand asset'));
    const note = params.memo?.trim() ? { note: params.memo } : {};
    if (!params.max) return this.buildPayment({ to: params.to, amount: params.amount.toString(), ...note });
    const spendable = BigInt((await this.backend.account(this.address)).spendable);
    const first = await this.buildPayment({ to: params.to, amount: (spendable - 10_000n).toString(), ...note }).catch(() => null);
    const fee = first ? BigInt(first.summary.fee) : 1_000n;
    const amount = spendable - fee;
    if (amount <= 0n) throw new Error(l10n('Rien à envoyer : tout ton solde est bloqué par le solde minimum', 'Nothing to send: your whole balance is locked by the minimum balance'));
    return this.buildPayment({ to: params.to, amount: amount.toString(), ...note });
  }

  /** `amount`: µALGO. Rust re-checks both minimum balances and the spendable amount. */
  async buildPayment(params: { to: string; amount: string; note?: string }): Promise<AlgoUnsigned> {
    const to = params.to.trim();
    if (!isAlgoAddress(to)) throw new Error(l10n('Adresse Algorand invalide (58 caractères A–Z, 2–7)', 'Invalid Algorand address (58 characters A–Z, 2–7)'));
    if (to === this.address) throw new Error(l10n('Paiement à soi-même impossible', 'Payment to yourself not possible'));
    if (!/^\d+$/.test(params.amount) || BigInt(params.amount) <= 0n) throw new Error(l10n('Montant en µALGO invalide', 'Invalid µALGO amount'));
    const note = params.note ?? '';
    if (algoNoteBytes(note) > ALGO_MAX_NOTE) throw new Error(l10n('Note trop longue (1024 octets au plus)', 'Note too long (1024 bytes at most)'));
    const built = await this.backend.build(to, params.amount, note || undefined);
    const s = built.summary;
    const noteOk = note ? s.noteLen === algoNoteBytes(note) && s.noteText === note : s.noteLen === 0;
    const extraOk = s.warnings.every((w) => w.kind === 'note' && note !== '');
    if (s.receiver !== to || s.sender !== this.address || s.amount !== params.amount || !noteOk || !extraOk) {
      throw new Error(l10n('Le paiement construit par Rust ne correspond pas à la demande', 'The payment built by Rust does not match the request'));
    }
    return {
      family: 'algo',
      blob: built.blob,
      summary: s,
      context: built.context,
      recipient: to,
      amount: BigInt(params.amount),
      ...(note ? { note } : {}),
      maxFee: BigInt(s.fee),
      size: { family: 'algo' },
    };
  }

  /** Ledger: same checks as `signTx`; Rust re-reads the key, shows its dialog, then the device signs. */
  signTxHw(unsigned: AlgoUnsigned, deviceId: string): Promise<AlgoSigned> {
    if (!this.hw) return Promise.reject(new Error(l10n('Ce compte n’est pas un hardware wallet', 'This account is not a hardware wallet')));
    return this.signTx(unsigned, deviceId);
  }

  /** Rust: live checks, native dialog (amount, receiver, note, fee, genesis), signature. */
  async signTx(unsigned: AlgoUnsigned, password: string): Promise<AlgoSigned> {
    const res = await this.backend.sign(unsigned.blob, password);
    if (!/^[A-Z2-7]{52}$/.test(res.txid) || res.txid !== unsigned.summary.txid) throw new Error(l10n('Identifiant de transaction Algorand inattendu', 'Unexpected Algorand transaction ID'));
    return { family: 'algo', blob: res.blob, txid: res.txid, summary: res.summary };
  }

  /** Rust verifies the signature and that algod's id is ours. */
  async broadcast(signed: AlgoSigned): Promise<string> {
    const txid = await this.backend.broadcast(signed.blob);
    if (txid !== signed.txid) throw new Error(l10n('Identifiant diffusé inattendu', 'Unexpected broadcast ID'));
    return txid;
  }

  txStatus(txid: string): Promise<AlgoTxStatus> {
    return this.backend.txStatus(txid);
  }

  async getHistory(): Promise<HistoryItem[]> {
    const list = await this.backend.txs(this.address);
    const known = this.knownAssets();
    return list.map((t) => {
      const out = t.from === this.address;
      const self = out && t.to === this.address;
      const k = t.type === 'axfer' && t.assetId != null ? known.find((x) => Number(x.contract) === t.assetId) : undefined;
      if (k && /^\d+$/.test(t.assetAmount ?? '')) {
        const optIn = self && t.assetAmount === '0';
        const item: HistoryItem = { id: t.id, chainKey: this.chain.key, assetId: `asa:${k.contract}`, direction: self ? 'self' : out ? 'out' : 'in', amount: BigInt(t.assetAmount ?? '0'), status: t.round ? 'confirmed' : 'pending', kind: 'transfer' };
        if (out) item.fee = BigInt(t.fee || '0');
        const counterparty = out ? t.to : t.from;
        if (counterparty && !self) item.counterparty = counterparty;
        if (t.time) item.time = t.time;
        if (optIn) item.note = l10n(`Activation de ${k.symbol} (opt-in, +0,1 ALGO de solde minimum)`, `${k.symbol} enabled (opt-in, +0.1 ALGO of minimum balance)`);
        else if (t.note) item.note = t.note;
        return item;
      }
      const item: HistoryItem = {
        id: t.id,
        chainKey: this.chain.key,
        assetId: 'algo',
        direction: self ? 'self' : out ? 'out' : 'in',
        amount: BigInt(t.amount || '0') + (t.closeTo === this.address || (out && t.closeTo) ? BigInt(t.closeAmount ?? '0') : 0n),
        status: t.round ? 'confirmed' : 'pending',
        kind: t.type === 'pay' ? 'transfer' : 'contract',
      };
      if (out) item.fee = BigInt(t.fee || '0');
      const counterparty = out ? t.to : t.from;
      if (counterparty) item.counterparty = counterparty;
      if (t.time) item.time = t.time;
      if (t.note) item.note = t.note;
      else if (t.type !== 'pay') item.note = l10n(`Transaction ${t.type} (non gérée par Kyro)`, `${t.type} transaction (not handled by Kyro)`);
      return item;
    });
  }
}
