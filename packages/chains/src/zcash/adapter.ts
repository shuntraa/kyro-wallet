// SPDX-License-Identifier: GPL-3.0-or-later
//
// Zcash, TRANSPARENT ADDRESSES ONLY (t1… / t3…, testnet tm… / t2…; ZIP-320 tex1… as a
// destination). Shielded (zs…, zc…) and unified (u1…) addresses are refused with a clear message:
// Kyro neither builds nor reads shielded parts. Transparent Zcash is as public as Bitcoin.
//
// BIP44 P2PKH `m/44'/133'/0'` (testnet `m/44'/1'/0'`). Reads and broadcast go through the Rust
// `zec_*` commands (docs/IPC.md §2.4b, Esplora shapes like Litecoin / Dogecoin). Sending: this
// adapter only proposes the candidate coins (outpoint + which of our addresses) and our next
// change index; Rust reads every previous transaction itself, selects the coins, computes the
// ZIP-317 fee, reads the consensus branch from the chain, builds the v5 transaction, shows it in
// the native dialog and signs it. There is no fee rate to choose (ZIP 317).

import { accountArg } from '../types';
import type { HDKey } from '@scure/bip32';
import {
  BTC_TXS_CAP,
  call,
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
  if (zecDestinationKind(a, other)) return `Adresse Zcash ${other} : ce portefeuille est sur ${network}.`;
  return 'Adresse Zcash invalide (attendu : t1…, t3… ou tex1…).';
}

export class ZcashAdapter implements ChainAdapter<'zec'> {
  readonly family = 'zec' as const;
  readonly chain: ZcashChain;
  readonly assetId = 'zec';
  private readonly backend: ZecBackend;
  private readonly key: HDKey;
  private readonly account: UtxoAccountInfo;
  private readonly gap: number;
  private scanCache: { at: number; addrs: DerivedZecAddress[] } | null = null;
  private scanning: Promise<DerivedZecAddress[]> | null = null;
  /** True when one address hit the 50-transaction cap: older ones are not shown. */
  historyCapped = false;

  constructor(opts: ZcashAdapterOptions) {
    this.chain = opts.chain;
    this.account = opts.account;
    this.backend = opts.backend ?? rustZecBackend(opts.vaultAccount ?? 0);
    this.gap = opts.gapLimit ?? 5;
    this.key = parseXpub(opts.account.xpub);
    const first = this.addressAt(0, 0);
    if (first.address !== opts.account.address) {
      throw new Error(`Dérivation Zcash incohérente avec le coffre (${first.address} ≠ ${opts.account.address})`);
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
      hint: 'frais ZIP 317 calculés par le coffre (≈ 0,0001 ZEC)',
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
        if (!Number.isSafeInteger(u.value) || u.value < 0) throw new Error('Montant de sortie hors limites');
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
    if (params.asset.id !== this.assetId) throw new Error('Actif incohérent avec cette chaîne');
    const to = params.to.trim();
    const problem = zecAddressProblem(to, this.chain.network);
    if (problem) throw new Error(problem);
    if (!params.max && params.amount <= 0n) throw new Error('Montant invalide');
    const { coins } = await this.candidates();
    if (coins.length === 0) throw new Error('Aucune pièce Zcash transparente à dépenser');
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
      throw new Error('La transaction signée par Rust diffère de l’aperçu');
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
      if (tx.shielded) item.note = direction === 'in' ? 'Reçu depuis une adresse protégée (détails privés)' : 'Vers une adresse protégée (montant net de ton adresse transparente)';
      if (tx.status.block_time) item.time = tx.status.block_time * 1000;
      items.push(item);
    }
    return items.sort((a, b) => (b.time ?? Infinity) - (a.time ?? Infinity));
  }
}
