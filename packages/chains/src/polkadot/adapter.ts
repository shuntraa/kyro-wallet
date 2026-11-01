// SPDX-License-Identifier: GPL-3.0-or-later
// Polkadot adapter (DOT on Polkadot Asset Hub, WND on Westend Asset Hub).

import { accountArg } from '../types';
import { call, l10n, type DotAccountInfo, type DotAssetBalance, type DotContext, type DotHistory, type DotTxSummary } from '@kyro/shared';
import { DOT_ASSETS, type PolkadotChain } from '../registry';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';

export type { DotAccountInfo, DotAssetBalance, DotContext, DotTxSummary };

export type DotTxState = 'pending' | 'finalized' | 'expired';

export interface DotBackend {
  account(address: string): Promise<DotAccountInfo>;
  build(to: string, amount: string): Promise<{ payload: string; summary: DotTxSummary; context: DotContext }>;
  sign(payload: string, password: string): Promise<{ extrinsic: string; hash: string; blockHash: string; summary: DotTxSummary; context: DotContext }>;
  broadcast(extrinsic: string, blockHash: string): Promise<string>;
  txStatus(address: string, nonce: number, validUntil: number): Promise<{ state: DotTxState; finalized: number }>;
  txs(address: string): Promise<DotHistory>;
  /** Tokens (known asset ids only); optional so that test backends can leave them out. */
  assetBalances?(address: string): Promise<DotAssetBalance[]>;
  buildAsset?(assetId: number, to: string, amount: string): Promise<{ payload: string; summary: DotTxSummary; context: DotContext }>;
}

/** Outcome of the last `getHistory`: `null` before the first one. */
export type DotHistoryStatus = 'ok' | 'partial' | 'unavailable' | null;

/** The typed `dot_*` commands of `@kyro/shared` (docs/IPC.md §2.11), for vault account `account`. */
export function rustDotBackend(account = 0): DotBackend {
  const acct = accountArg(account);
  return {
    account: (address) => call('dot_account', { address }),
    build: (to, amount) => call('dot_build_tx', { to, amount, ...acct }),
    sign: (payload, password) => call('dot_sign_tx', { payload, password, ...acct }),
    broadcast: (extrinsic, blockHash) => call('dot_broadcast', { extrinsic, blockHash, ...acct }),
    txStatus: (address, nonce, validUntil) => call('dot_tx_status', { address, nonce, validUntil }),
    txs: (address) => call('dot_txs', { address }),
    assetBalances: (address) => call('dot_asset_balances', { address }),
    buildAsset: (assetId, to, amount) => call('dot_build_asset_tx', { assetId, to, amount, ...acct }),
  };
}


/** SS58 address shape of the network: prefix 0 (Polkadot, « 1… ») on mainnet, 42 (generic, « 5… ») on Westend; base58, 47–48 characters. */
export function isDotAddress(address: string, network: 'mainnet' | 'testnet'): boolean {
  const a = address.trim();
  const first = network === 'mainnet' ? '1' : '5';
  return a.startsWith(first) && /^[1-9A-HJ-NP-Za-km-z]{46,48}$/.test(a);
}

/** Why an address that looks like SS58 is not for this network (null = fine or not SS58). */
export function dotAddressProblem(address: string, network: 'mainnet' | 'testnet'): string | null {
  const a = address.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{46,48}$/.test(a) || isDotAddress(a, network)) return null;
  if (network === 'mainnet' && a.startsWith('5')) return l10n('Adresse au format générique (« 5… ») : demande l’adresse Polkadot (« 1… ») du destinataire, ou convertis-la (même compte, préfixe 0).', 'Generic-format address (“5…”): ask the recipient for their Polkadot address (“1…”), or convert it (same account, prefix 0).');
  if (network === 'testnet' && a.startsWith('1')) return l10n('Adresse Polkadot mainnet (« 1… ») : sur Westend, Kyro attend le format générique (« 5… »).', 'Polkadot mainnet address (“1…”): on Westend, Kyro expects the generic format (“5…”).');
  return l10n('Adresse d’un autre réseau Substrate (Kusama ou autre) : refusée.', 'Address from another Substrate network (Kusama or other): refused.');
}


export interface DotUnsigned {
  family: 'dot';
  /** Signing payload, hex: what Rust decodes and signs. */
  payload: string;
  summary: DotTxSummary;
  context: DotContext;
  recipient: string;
  /** Planck (token: its base units). */
  amount: bigint;
  /** Fee estimate of the node (planck of DOT), paid on top of the amount. */
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
    if (!isDotAddress(opts.address, opts.chain.network)) throw new Error(l10n('Adresse Polkadot invalide', 'Invalid Polkadot address'));
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
    const out = [{ assetId: 'dot', amount: BigInt(acc.free), spendable: BigInt(acc.spendable) }];
    for (const b of await this.assetBalances()) {
      if (/^\d+$/.test(b.balance) && b.balance !== '0') {
        const keep = BigInt(b.minBalance || '0');
        out.push({ assetId: `dotasset:${b.assetId}`, amount: BigInt(b.balance), spendable: b.frozen ? 0n : BigInt(b.balance) > keep ? BigInt(b.balance) - keep : 0n });
      }
    }
    return out;
  }

  /** Known tokens of the network (USD₮, USDC on Polkadot Asset Hub). */
  knownAssets() {
    return DOT_ASSETS[this.chain.network];
  }

  /** Holdings of the known tokens (rows for an unknown asset id are dropped). */
  async assetBalances(address = this.address): Promise<DotAssetBalance[]> {
    if (!this.backend.assetBalances || !this.knownAssets().length) return [];
    const known = new Set(this.knownAssets().map((k) => Number(k.contract)));
    return (await this.backend.assetBalances(address)).filter((b) => known.has(b.assetId));
  }

  /** Token transfer (`Assets.transfer_keep_alive`): `max` = balance − the token's minimum balance (it stays). */
  private async buildAssetTx(params: BuildParams): Promise<DotUnsigned> {
    const k = this.knownAssets().find((x) => `dotasset:${x.contract}` === params.asset.id);
    if (!k || k.decimals !== params.asset.decimals || !this.backend.buildAsset) throw new Error(l10n('Jeton Polkadot inconnu', 'Unknown Polkadot token'));
    const assetId = Number(k.contract);
    const to = params.to.trim();
    if (!isDotAddress(to, this.chain.network)) throw new Error(dotAddressProblem(to, this.chain.network) ?? l10n('Adresse Polkadot invalide', 'Invalid Polkadot address'));
    if (to === this.address) throw new Error(l10n('Transfert à soi-même impossible', 'Cannot transfer to yourself'));
    let amount = params.amount;
    if (params.max === true) {
      const b = (await this.assetBalances()).find((x) => x.assetId === assetId);
      amount = b ? BigInt(b.balance) - BigInt(b.minBalance) : 0n;
    }
    if (amount <= 0n) throw new Error(l10n('Montant invalide', 'Invalid amount'));
    const built = await this.backend.buildAsset(assetId, to, amount.toString());
    const s = built.summary;
    const a = s.asset;
    if (!a || a.assetId !== assetId || a.decimals !== k.decimals || s.decimals !== k.decimals || s.to !== to || s.from !== this.address || s.amount !== amount.toString() || s.call !== 'Assets.transfer_keep_alive' || s.tip !== '0') {
      throw new Error(l10n('Le transfert construit par Rust ne correspond pas à la demande', 'The transfer built by Rust does not match the request'));
    }
    return { family: 'dot', payload: built.payload, summary: s, context: built.context, recipient: to, amount, maxFee: BigInt(built.context.fee), size: { family: 'dot' } };
  }

  /** No fee to choose: weight and length fee of the runtime, estimated by the node, no tip. */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'dot' as const };
    const eta = this.chain.blockTimeSecs * 3;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: l10n(`frais fixés par le runtime (≈ 0,015 ${this.chain.nativeSymbol}), sans pourboire`, `fee set by the runtime (≈ 0.015 ${this.chain.nativeSymbol}), no tip`),
      fetchedAt: Date.now(),
    });
  }

  /** `max`: spendable minus the fee Rust estimates, built twice. */
  async buildTx(params: BuildParams): Promise<DotUnsigned> {
    if (params.asset.kind === 'dotasset') return this.buildAssetTx(params);
    if (params.asset.kind !== 'native') throw new Error(l10n('Actif Polkadot inattendu', 'Unexpected Polkadot asset'));
    if (!params.max) return this.buildTransfer(params.to, params.amount);
    const spendable = BigInt((await this.backend.account(this.address)).spendable);
    const unit = 10n ** BigInt(this.chain.nativeDecimals);
    // First pass with a fee ceiling of 0.1 token; then exactly spendable − fee.
    const first = await this.buildTransfer(params.to, spendable - unit / 10n).catch(() => null);
    const fee = first ? first.maxFee : unit / 10n;
    const amount = spendable - fee;
    if (amount <= 0n) throw new Error(l10n('Rien à envoyer : ton solde disponible ne couvre pas les frais (le dépôt existentiel reste sur le compte)', 'Nothing to send: your available balance does not cover the fee (the existential deposit stays on the account)'));
    return this.buildTransfer(params.to, amount);
  }

  /** `amount` in planck. Rust re-checks existential deposit, balance and fee. */
  async buildTransfer(toInput: string, amount: bigint): Promise<DotUnsigned> {
    const to = toInput.trim();
    if (!isDotAddress(to, this.chain.network)) throw new Error(dotAddressProblem(to, this.chain.network) ?? l10n('Adresse Polkadot invalide', 'Invalid Polkadot address'));
    if (to === this.address) throw new Error(l10n('Transfert à soi-même impossible', 'Cannot transfer to yourself'));
    if (amount <= 0n) throw new Error(l10n('Montant invalide', 'Invalid amount'));
    const built = await this.backend.build(to, amount.toString());
    const s = built.summary;
    if (s.to !== to || s.from !== this.address || s.amount !== amount.toString() || s.call !== 'Balances.transfer_keep_alive' || s.tip !== '0') {
      throw new Error(l10n('Le transfert construit par Rust ne correspond pas à la demande', 'The transfer built by Rust does not match the request'));
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
    if (!/^[0-9a-f]{64}$/i.test(res.hash)) throw new Error(l10n('Hash Polkadot inattendu', 'Unexpected Polkadot hash'));
    return { family: 'dot', extrinsic: res.extrinsic, hash: res.hash, blockHash: res.blockHash, summary: res.summary, validUntil: res.context.validUntil };
  }

  /** Rust verifies the signature and that the node's hash is ours. */
  async broadcast(signed: DotSigned): Promise<string> {
    const hash = await this.backend.broadcast(signed.extrinsic, signed.blockHash);
    if (hash.toLowerCase() !== signed.hash.toLowerCase()) throw new Error(l10n('Hash diffusé inattendu', 'Unexpected broadcast hash'));
    return hash;
  }

  /** By nonce: `finalized` once used in the finalized state, `expired` after the era. */
  txStatus(nonce: number, validUntil: number): Promise<{ state: DotTxState; finalized: number }> {
    return this.backend.txStatus(this.address, nonce, validUntil);
  }

  historyStatus: DotHistoryStatus = null;

  /** Native DOT transfers (Statescan via Rust). Never throws: see `historyStatus`. */
  async getHistory(): Promise<HistoryItem[]> {
    let h: DotHistory;
    try {
      h = await this.backend.txs(this.address);
    } catch {
      this.historyStatus = 'unavailable';
      return [];
    }
    if (!h || !h.available || !Array.isArray(h.items)) {
      this.historyStatus = 'unavailable';
      return [];
    }
    this.historyStatus = h.partial ? 'partial' : 'ok';
    const out: HistoryItem[] = [];
    for (const e of h.items) {
      if (!/^\d+$/.test(e.amount) || !Number.isFinite(e.time)) continue;
      const item: HistoryItem = {
        id: e.id,
        chainKey: this.chain.key,
        assetId: 'dot',
        direction: e.direction,
        amount: BigInt(e.amount),
        time: e.time,
        status: 'confirmed',
        kind: 'transfer',
      };
      const counterparty = e.direction === 'out' ? e.to : e.direction === 'in' ? e.from : undefined;
      if (counterparty) item.counterparty = counterparty;
      if (e.chain === 'relay') item.note = l10n('Relay chain Polkadot (avant la migration vers Asset Hub)', 'Polkadot relay chain (before the Asset Hub migration)');
      out.push(item);
    }
    return out;
  }
}
