// SPDX-License-Identifier: GPL-3.0-or-later
// Zcash, TRANSPARENT ADDRESSES ONLY (t1… / t3…, testnet tm… / t2…; ZIP-320 tex1… as a destination).

import { accountArg } from '../types';
import type { HDKey } from '@scure/bip32';
import {
  BTC_TXS_CAP,
  call,
  l10n,
  zecDestinationKind,
  zecP2pkhAddress,
  zecShieldedRefusal,
  type EsploraAddressInfo,
  type EsploraTx,
  type EsploraUtxo,
  type UtxoAccountInfo,
  type ZecCandidate,
  type ZecSendArgs,
  type ZecTxSummary,
} from '@kyro/shared';
import type { ZcashChain } from '../registry';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';
import { derivePubkey, parseXpub } from '../bitcoin/xpub';
import type { HwSigner } from '../hw';

export type { ZecTxSummary } from '@kyro/shared';

/** What the adapter needs from Rust: one method per `zec_*` command. */
export interface ZecBackend {
  addressInfo(address: string): Promise<EsploraAddressInfo>;
  addressUtxos(address: string): Promise<Array<EsploraUtxo & { coinbase?: boolean }>>;
  addressTxs(address: string): Promise<Array<EsploraTx & { shielded?: boolean }>>;
  tipHeight(): Promise<number>;
  broadcast(hex: string): Promise<string>;
  preview(request: ZecSendArgs): Promise<ZecTxSummary>;
  sign(request: ZecSendArgs, password: string): Promise<{ hex: string; txid: string; summary: ZecTxSummary }>;
}

/** The typed `zec_*` commands (docs/IPC.md §2.4b), signing with vault account `account`. */
export function rustZecBackend(account = 0): ZecBackend {
  const acct = accountArg(account);
  return {
    addressInfo: (address) => call('zec_address_info', { address }),
    addressUtxos: (address) => call('zec_address_utxos', { address }),
    addressTxs: (address) => call('zec_address_txs', { address }),
    tipHeight: async () => Number(await call('zec_tip_height')),
    broadcast: (hex) => call('zec_broadcast', { hex }),
    preview: (request) => call('zec_send_preview', { request, ...acct }),
    sign: (request, password) => call('zec_sign', { request, password, ...acct }),
  };
}

/** Hardware-wallet account `accountId` (docs/IPC.md §2.3, Trezor): Rust builds from the stored xpub (`hw_zec_send_preview`); signing is `hw_sign_zec_tx`; reads and broadcast as the vault. */
export function hwZecBackend(accountId: string): ZecBackend {
  return {
    ...rustZecBackend(0),
    preview: (request) => call('hw_zec_send_preview', { accountId, request }),
    sign: () => Promise.reject(new Error(l10n('Compte hardware wallet : signature sur l’appareil', 'Hardware-wallet account: sign on the device'))),
  };
}

export interface ZecUnsigned {
  family: 'zec';
  /** What Rust rebuilds at signing time (same coins, recipient, amount, change index). */
  request: ZecSendArgs;
  /** Rust's construction, decoded (preview). */
  summary: ZecTxSummary;
  amount: bigint;
  recipient: string;
  fee: bigint;
  maxFee: bigint;
  size: { family: 'zec' };
}

export interface ZecSigned {
  family: 'zec';
  hex: string;
  txid: string;
  summary: ZecTxSummary;
}

export interface DerivedZecAddress {
  change: 0 | 1;
  index: number;
  address: string;
  used: boolean;
  balance: bigint;
}

export interface ZcashAdapterOptions {
  chain: ZcashChain;
  account: UtxoAccountInfo;
  backend?: ZecBackend;
  gapLimit?: number;
  /** Vault account index (docs/IPC.md §2.9); absent = 0. */
  vaultAccount?: number;
  /** Hardware-wallet account (signing through `hw_sign_zec_tx`, Trezor). */
  hw?: HwSigner;
}

const SCAN_TTL_MS = 30_000;
const MAX_SCAN = 40;

/** Message for a destination Kyro refuses, `null` when it is a valid transparent address. */
export function zecAddressProblem(address: string, network: ZcashChain['network']): string | null {
  const a = address.trim();
  if (!a) return null;
  const shielded = zecShieldedRefusal(a);
  if (shielded) return shielded;
  if (zecDestinationKind(a, network)) return null;
  const other = network === 'mainnet' ? 'testnet' : 'mainnet';
  if (zecDestinationKind(a, other)) return l10n(`Adresse Zcash ${other} : ce portefeuille est sur ${network}.`, `Zcash ${other} address: this wallet is on ${network}.`);
  return l10n('Adresse Zcash invalide (attendu : t1…, t3… ou tex1…).', 'Invalid Zcash address (expected: t1…, t3… or tex1…).');
}

export class ZcashAdapter implements ChainAdapter<'zec'> {
  readonly family = 'zec' as const;
  readonly chain: ZcashChain;
  readonly assetId = 'zec';
  private readonly backend: ZecBackend;
  private readonly key: HDKey;
  private readonly account: UtxoAccountInfo;
  private readonly gap: number;
  readonly hw: HwSigner | null;
  private scanCache: { at: number; addrs: DerivedZecAddress[] } | null = null;
  private scanning: Promise<DerivedZecAddress[]> | null = null;
  /** True when one address hit the 50-transaction cap: older ones are not shown. */
  historyCapped = false;

  constructor(opts: ZcashAdapterOptions) {
    this.chain = opts.chain;
    this.account = opts.account;
    this.hw = opts.hw ?? null;
    this.backend = opts.backend ?? (opts.hw ? hwZecBackend(opts.hw.accountId) : rustZecBackend(opts.vaultAccount ?? 0));
    this.gap = opts.gapLimit ?? 5;
    this.key = parseXpub(opts.account.xpub);
    const first = this.addressAt(0, 0);
    if (first.address !== opts.account.address) {
      throw new Error(l10n(`Dérivation Zcash incohérente avec le coffre (${first.address} ≠ ${opts.account.address})`, `Zcash derivation inconsistent with the vault (${first.address} ≠ ${opts.account.address})`));
    }
  }

  getAddress(): string {
    return this.account.address;
  }

  /** Transparent destinations only (t1…, t3…, tex1…); shielded and unified are refused. */
  isValidAddress(address: string): boolean {
    return zecDestinationKind(address, this.chain.network) !== null;
  }

  addressAt(change: 0 | 1, index: number): DerivedZecAddress {
    const pubkey = derivePubkey(this.key, change, index);
    return { change, index, address: zecP2pkhAddress(pubkey, this.chain.network), used: false, balance: 0n };
  }

  /** Gap-limit scan of the receive and change branches. Cached 30 s. */
  async scan(force = false): Promise<DerivedZecAddress[]> {
    if (!force && this.scanCache && Date.now() - this.scanCache.at < SCAN_TTL_MS) return this.scanCache.addrs;
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const out: DerivedZecAddress[] = [];
      await Promise.all(
        ([0, 1] as const).map(async (change) => {
          let unused = 0;
          for (let i = 0; i < MAX_SCAN && unused < (change === 0 ? this.gap : Math.max(2, this.gap - 2)); i++) {
            const d = this.addressAt(change, i);
            const info = await this.backend.addressInfo(d.address);
            d.used = info.chain_stats.tx_count + info.mempool_stats.tx_count > 0;
            d.balance = BigInt(info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum + info.mempool_stats.funded_txo_sum - info.mempool_stats.spent_txo_sum);
            out.push(d);
            unused = d.used ? 0 : unused + 1;
          }
        }),
      );
      this.scanCache = { at: Date.now(), addrs: out };
      return out;
    })();
    try {
      return await this.scanning;
    } finally {
      this.scanning = null;
    }
  }

  async getBalance(): Promise<Balance[]> {
    const addrs = await this.scan();
    return [{ assetId: this.assetId, amount: addrs.reduce((s, a) => s + a.balance, 0n) }];
  }

  tipHeight(): Promise<number> {
    return this.backend.tipHeight();
  }

  /** No fee to choose: ZIP 317 (5 000 zatoshis per logical action, 10 000 minimum), computed by Rust. */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'zec' as const };
    const eta = this.chain.blockTimeSecs;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta * 2 }, normal: { level: 'normal', params: p, etaSecs: eta * 2 }, fast: { level: 'fast', params: p, etaSecs: eta * 2 } },
      minimum: p,
      hint: l10n('frais ZIP 317 calculés par le coffre (≈ 0,0001 ZEC)', 'ZIP 317 fee computed by the vault (≈ 0.0001 ZEC)'),
      fetchedAt: Date.now(),
    });
  }

  /** Candidate coins of the account (Rust re-reads each previous transaction). Mined (coinbase) coins are left out. */
  private async candidates(): Promise<{ coins: ZecCandidate[]; total: bigint }> {
    const addrs = (await this.scan()).filter((a) => a.used);
    const lists = await Promise.all(addrs.map(async (owner) => ({ owner, list: await this.backend.addressUtxos(owner.address) })));
    const coins: ZecCandidate[] = [];
    let total = 0n;
    for (const { owner, list } of lists) {
      for (const u of list) {
        if (u.coinbase) continue;
        if (!Number.isSafeInteger(u.value) || u.value < 0) throw new Error(l10n('Montant de sortie hors limites', 'Output amount out of range'));
        coins.push({ txid: u.txid, vout: u.vout, change: owner.change === 1, index: owner.index });
        total += BigInt(u.value);
      }
    }
    return { coins, total };
  }

  private async changeIndex(): Promise<number> {
    const known = (await this.scan()).filter((a) => a.change === 1);
    for (let i = 0; i < MAX_SCAN; i++) {
      const k = known.find((a) => a.index === i);
      if (!k || !k.used) return i;
    }
    return MAX_SCAN;
  }

  async buildTx(params: BuildParams): Promise<ZecUnsigned> {
    if (params.asset.id !== this.assetId) throw new Error(l10n('Actif incohérent avec cette chaîne', 'Asset inconsistent with this chain'));
    const to = params.to.trim();
    const problem = zecAddressProblem(to, this.chain.network);
    if (problem) throw new Error(problem);
    if (!params.max && params.amount <= 0n) throw new Error(l10n('Montant invalide', 'Invalid amount'));
    const { coins } = await this.candidates();
    if (coins.length === 0) throw new Error(l10n('Aucune pièce Zcash transparente à dépenser', 'No transparent Zcash coin to spend'));
    const request: ZecSendArgs = { to, amount: params.max ? '' : params.amount.toString(), max: !!params.max, coins, changeIndex: await this.changeIndex() };
    const summary = await this.backend.preview(request);
    const fee = BigInt(summary.fee);
    return { family: 'zec', request, summary, amount: BigInt(summary.amount), recipient: to, fee, maxFee: fee, size: { family: 'zec' } };
  }

  /** Rust: password, construction and decoding, native dialog (+ reinforced one if needed), signature. */
  async signTx(unsigned: ZecUnsigned, password: string): Promise<ZecSigned> {
    const res = await this.backend.sign(unsigned.request, password);
    const s = res.summary;
    if (s.toAddress !== unsigned.summary.toAddress || (!unsigned.request.max && s.amount !== unsigned.summary.amount)) {
      throw new Error(l10n('La transaction signée par Rust diffère de l’aperçu', 'The transaction signed by Rust differs from the preview'));
    }
    return { family: 'zec', hex: res.hex, txid: res.txid, summary: s };
  }

  /** Hardware wallet (Trezor): Rust's construction and dialog, the device, then every signature verified in Rust. */
  async signTxHw(unsigned: ZecUnsigned, deviceId: string): Promise<ZecSigned> {
    if (!this.hw) throw new Error(l10n('Ce compte n’est pas un hardware wallet', 'This account is not a hardware wallet'));
    const res = await call('hw_sign_zec_tx', { id: deviceId, accountId: this.hw.accountId, request: unsigned.request });
    const s = res.summary;
    if (s.toAddress !== unsigned.summary.toAddress || (!unsigned.request.max && s.amount !== unsigned.summary.amount)) {
      throw new Error(l10n('La transaction signée diffère de l’aperçu', 'The signed transaction differs from the preview'));
    }
    return { family: 'zec', hex: res.hex, txid: res.txid, summary: s };
  }

  /** Rust checks that the server's txid matches the transaction (ZIP 244). */
  async broadcast(signed: ZecSigned): Promise<string> {
    return (await this.backend.broadcast(signed.hex)).trim() || signed.txid;
  }

  async getHistory(): Promise<HistoryItem[]> {
    const addrs = (await this.scan()).filter((a) => a.used);
    const own = new Set(addrs.map((a) => a.address));
    const lists = await Promise.all(addrs.map((a) => this.backend.addressTxs(a.address)));
    this.historyCapped = lists.some((l) => l.length >= BTC_TXS_CAP);
    const seen = new Map<string, EsploraTx & { shielded?: boolean }>();
    for (const list of lists) for (const tx of list) seen.set(tx.txid, tx);
    const items: HistoryItem[] = [];
    for (const tx of seen.values()) {
      const spent = tx.vin.reduce((s, i) => s + (i.prevout?.scriptpubkey_address && own.has(i.prevout.scriptpubkey_address) ? BigInt(i.prevout.value) : 0n), 0n);
      const received = tx.vout.reduce((s, o) => s + (o.scriptpubkey_address && own.has(o.scriptpubkey_address) ? BigInt(o.value) : 0n), 0n);
      const fee = BigInt(tx.fee ?? 0);
      const external = tx.vout.find((o) => !o.scriptpubkey_address || !own.has(o.scriptpubkey_address));
      const sender = tx.vin.find((i) => i.prevout?.scriptpubkey_address && !own.has(i.prevout.scriptpubkey_address))?.prevout?.scriptpubkey_address;
      const direction = spent === 0n ? 'in' : external || tx.shielded ? 'out' : 'self';
      const delta = received - spent;
      const counterparty = direction === 'in' ? sender : external?.scriptpubkey_address;
      const item: HistoryItem = {
        id: tx.txid,
        chainKey: this.chain.key,
        assetId: this.assetId,
        direction,
        amount: direction === 'in' ? delta : direction === 'self' ? fee : -delta - (spent > 0n ? fee : 0n),
        status: tx.status.confirmed ? 'confirmed' : 'pending',
        kind: 'transfer',
      };
      if (spent > 0n && !tx.shielded) item.fee = fee;
      if (counterparty) item.counterparty = counterparty;
      if (tx.shielded) item.note = direction === 'in' ? l10n('Reçu depuis une adresse protégée (détails privés)', 'Received from a shielded address (private details)') : l10n('Vers une adresse protégée (montant net de ton adresse transparente)', 'To a shielded address (net amount from your transparent address)');
      if (tx.status.block_time) item.time = tx.status.block_time * 1000;
      items.push(item);
    }
    return items.sort((a, b) => (b.time ?? Infinity) - (a.time ?? Infinity));
  }
}
