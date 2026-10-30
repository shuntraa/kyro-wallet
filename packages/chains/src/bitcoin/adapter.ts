// SPDX-License-Identifier: GPL-3.0-or-later
//
// Bitcoin adapter (BIP84 SegWit + BIP86 Taproot).
//
// Every read and the broadcast go through the Rust `btc_*` commands (docs/IPC.md §2.2),
// which return Esplora shapes whatever the user's server (default mempool.space, Esplora,
// Electrum, Bitcoin Core). Rust picks the server and never falls back to the default:
// this adapter never calls `net_fetch` for Bitcoin.
//
// - Addresses are derived from the account xpubs (public derivation only).
// - Unsigned PSBTs carry witnessUtxo + bip32Derivation / tapBip32Derivation so
//   that wallet-core can find the keys; signing happens in Rust.

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import type { HDKey } from '@scure/bip32';
import { BTC_TXS_CAP, call, type Accounts, type BtcKind, type BtcTxSummary, type EsploraTx } from '@kyro/shared';
import type { BtcChain } from '../registry';
import type { Balance, BtcSigned, BtcUnsigned, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';
import { outputTypeOf, selectAll, selectCoins, type SelectableUtxo } from './coinselect';
import { derivePubkey, fingerprintBytes, parseXpub } from './xpub';

bitcoin.initEccLib(ecc);

export interface DerivedAddress {
  kind: BtcKind;
  change: 0 | 1;
  index: number;
  address: string;
  pubkey: Uint8Array;
  path: string;
  used: boolean;
  balance: bigint;
}

export interface BitcoinAdapterOptions {
  chain: BtcChain;
  accounts: Accounts['btc'];
  /** Consecutive unused addresses before stopping a scan. */
  gapLimit?: number;
}

const SCAN_TTL_MS = 30_000;
const MAX_SCAN = 40;

export class BitcoinAdapter implements ChainAdapter<'btc'> {
  readonly family = 'btc' as const;
  readonly chain: BtcChain;
  private readonly net: bitcoin.Network;
  private readonly gap: number;
  private readonly accounts: Accounts['btc'];
  private readonly keys: Record<BtcKind, HDKey>;
  private scanCache: { at: number; addrs: DerivedAddress[] } | null = null;
  private scanning: Promise<DerivedAddress[]> | null = null;
  /**
   * True when the last `getHistory` hit the server cap (`BTC_TXS_CAP` transactions for at
   * least one address): older transactions are not shown. The UI says "50 dernières".
   */
  historyCapped = false;

  constructor(opts: BitcoinAdapterOptions) {
    this.chain = opts.chain;
    this.accounts = opts.accounts;
    this.net = opts.chain.network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
    this.gap = opts.gapLimit ?? 5;
    this.keys = { segwit: parseXpub(opts.accounts.segwit.xpub), taproot: parseXpub(opts.accounts.taproot.xpub) };
    // Sanity check: our derivation must match what Rust derived.
    for (const kind of ['segwit', 'taproot'] as const) {
      const first = this.addressAt(kind, 0, 0);
      if (first.address !== opts.accounts[kind].address) {
        throw new Error(`Dérivation ${kind} incohérente avec le coffre (${first.address} ≠ ${opts.accounts[kind].address})`);
      }
    }
  }

  getAddress(kind: BtcKind = 'segwit'): string {
    return this.accounts[kind].address;
  }

  isValidAddress(address: string): boolean {
    try {
      bitcoin.address.toOutputScript(address.trim(), this.net);
      return true;
    } catch {
      return false;
    }
  }

  /** Public derivation of `kind/change/index`. */
  addressAt(kind: BtcKind, change: 0 | 1, index: number): DerivedAddress {
    const pubkey = derivePubkey(this.keys[kind], change, index);
    const payment = kind === 'segwit' ? bitcoin.payments.p2wpkh({ pubkey, network: this.net }) : bitcoin.payments.p2tr({ internalPubkey: pubkey.slice(1, 33), network: this.net });
    if (!payment.address) throw new Error('Adresse introuvable');
    return { kind, change, index, address: payment.address, pubkey, path: `${this.accounts[kind].path}/${change}/${index}`, used: false, balance: 0n };
  }

  /** Gap-limit scan of both kinds and both branches. Cached 30 s. */
  async scan(force = false): Promise<DerivedAddress[]> {
    if (!force && this.scanCache && Date.now() - this.scanCache.at < SCAN_TTL_MS) return this.scanCache.addrs;
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const out: DerivedAddress[] = [];
      const branches: Array<[BtcKind, 0 | 1]> = [['segwit', 0], ['segwit', 1], ['taproot', 0], ['taproot', 1]];
      await Promise.all(
        branches.map(async ([kind, change]) => {
          let unused = 0;
          for (let i = 0; i < MAX_SCAN && unused < (change === 0 ? this.gap : Math.max(2, this.gap - 2)); i++) {
            const d = this.addressAt(kind, change, i);
            const info = await call('btc_address_info', { address: d.address });
            const txs = info.chain_stats.tx_count + info.mempool_stats.tx_count;
            d.used = txs > 0;
            // Esplora: funded − spent. Electrum / Core: funded already carries the net balance
            // (spent = 0, or the negative part of an unconfirmed spend): same formula.
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
    return [{ assetId: 'btc', amount: addrs.reduce((s, a) => s + a.balance, 0n) }];
  }

  async tipHeight(): Promise<number> {
    return Number(await call('btc_tip_height'));
  }

  async estimateFees(): Promise<FeeEstimates> {
    const f = await call('btc_fee_rates');
    const min = Math.max(1, f.minimumFee);
    const slow = Math.max(min, f.hourFee);
    const normal = Math.max(slow, f.halfHourFee);
    const fast = Math.max(normal, f.fastestFee);
    return {
      options: {
        slow: { level: 'slow', params: { family: 'btc', satPerVb: slow }, etaSecs: 3600 },
        normal: { level: 'normal', params: { family: 'btc', satPerVb: normal }, etaSecs: 1800 },
        fast: { level: 'fast', params: { family: 'btc', satPerVb: fast }, etaSecs: 600 },
      },
      minimum: { family: 'btc', satPerVb: min },
      hint: `${normal} sat/vB`,
      fetchedAt: Date.now(),
    };
  }

  private async utxos(): Promise<Array<SelectableUtxo & { owner: DerivedAddress }>> {
    const addrs = (await this.scan()).filter((a) => a.used);
    const lists = await Promise.all(
      addrs.map(async (owner) => {
        const list = await call('btc_address_utxos', { address: owner.address });
        return list.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), type: owner.kind === 'segwit' ? ('p2wpkh' as const) : ('p2tr' as const), owner }));
      }),
    );
    return lists.flat();
  }

  /** First never-used SegWit change address. */
  private async changeAddress(): Promise<DerivedAddress> {
    const addrs = await this.scan();
    const used = addrs.filter((a) => a.kind === 'segwit' && a.change === 1);
    for (let i = 0; i < MAX_SCAN; i++) {
      const known = used.find((a) => a.index === i);
      if (!known || !known.used) return this.addressAt('segwit', 1, i);
    }
    return this.addressAt('segwit', 1, MAX_SCAN);
  }

  async buildTx(params: BuildParams): Promise<BtcUnsigned> {
    if (params.fee.family !== 'btc') throw new Error('Frais Bitcoin attendus');
    const to = params.to.trim();
    if (!this.isValidAddress(to)) throw new Error('Adresse Bitcoin invalide pour ce réseau');
    const utxos = await this.utxos();
    const recipientType = outputTypeOf(to);
    const sel = params.max ? selectAll(utxos, params.fee.satPerVb, recipientType) : selectCoins(utxos, params.amount, params.fee.satPerVb, recipientType, 'p2wpkh');
    const psbt = new bitcoin.Psbt({ network: this.net });
    for (const u of sel.inputs) {
      const owner = (u as (typeof utxos)[number]).owner;
      const fp = fingerprintBytes(this.accounts[owner.kind].fingerprint);
      const script = bitcoin.address.toOutputScript(owner.address, this.net);
      if (owner.kind === 'segwit') {
        psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script, value: u.value }, bip32Derivation: [{ masterFingerprint: fp, pubkey: owner.pubkey, path: owner.path }] });
      } else {
        const xonly = owner.pubkey.slice(1, 33);
        psbt.addInput({
          hash: u.txid,
          index: u.vout,
          witnessUtxo: { script, value: u.value },
          tapInternalKey: xonly,
          tapBip32Derivation: [{ masterFingerprint: fp, pubkey: xonly, path: owner.path, leafHashes: [] }],
        });
      }
    }
    psbt.addOutput({ address: to, value: sel.amount });
    const outputs: BtcTxSummary['outputs'] = [[to, Number(sel.amount), false]];
    if (sel.change > 0n) {
      const change = await this.changeAddress();
      psbt.addOutput({
        address: change.address,
        value: sel.change,
        bip32Derivation: [{ masterFingerprint: fingerprintBytes(this.accounts.segwit.fingerprint), pubkey: change.pubkey, path: change.path }],
      });
      outputs.push([change.address, Number(sel.change), true]);
    }
    return {
      family: 'btc',
      psbt: psbt.toBase64(),
      amount: sel.amount,
      recipient: to,
      fee: sel.fee,
      maxFee: sel.fee,
      summary: { outputs, feeSats: Number(sel.fee) },
      size: { family: 'btc', vsize: sel.vsize },
    };
  }

  async signTx(unsigned: BtcUnsigned, password: string): Promise<BtcSigned> {
    const res = await call('btc_sign_psbt', { psbt: unsigned.psbt, password });
    const psbt = bitcoin.Psbt.fromBase64(res.psbt, { network: this.net });
    const finalized = psbt.data.inputs.every((i) => i.finalScriptWitness || i.finalScriptSig);
    if (!finalized) psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    return { family: 'btc', hex: tx.toHex(), txid: tx.getId() };
  }

  async broadcast(signed: BtcSigned): Promise<string> {
    // Rust checks that the server's txid matches the transaction.
    const txid = (await call('btc_broadcast', { hex: signed.hex })).trim();
    return txid || signed.txid;
  }

  async getHistory(): Promise<HistoryItem[]> {
    const addrs = (await this.scan()).filter((a) => a.used);
    const own = new Set(addrs.map((a) => a.address));
    const seen = new Map<string, EsploraTx>();
    // At most BTC_TXS_CAP most recent per address (unconfirmed first).
    const lists = await Promise.all(addrs.map((a) => call('btc_address_txs', { address: a.address })));
    this.historyCapped = lists.some((l) => l.length >= BTC_TXS_CAP);
    for (const list of lists) for (const tx of list) seen.set(tx.txid, tx);
    const items: HistoryItem[] = [];
    for (const tx of seen.values()) {
      // `prevout: null` = funding tx unknown to the server (Core: outside the wallet), never ours.
      const spent = tx.vin.reduce((s, i) => s + (i.prevout?.scriptpubkey_address && own.has(i.prevout.scriptpubkey_address) ? BigInt(i.prevout.value) : 0n), 0n);
      const received = tx.vout.reduce((s, o) => s + (o.scriptpubkey_address && own.has(o.scriptpubkey_address) ? BigInt(o.value) : 0n), 0n);
      const fee = BigInt(tx.fee ?? 0);
      const delta = received - spent;
      const external = tx.vout.find((o) => !o.scriptpubkey_address || !own.has(o.scriptpubkey_address));
      const sender = tx.vin.find((i) => i.prevout?.scriptpubkey_address && !own.has(i.prevout.scriptpubkey_address))?.prevout?.scriptpubkey_address;
      const direction = spent === 0n ? 'in' : external ? 'out' : 'self';
      const counterparty = direction === 'in' ? sender : external?.scriptpubkey_address;
      const item: HistoryItem = {
        id: tx.txid,
        chainKey: this.chain.key,
        assetId: 'btc',
        direction,
        amount: direction === 'in' ? delta : direction === 'self' ? fee : -delta - (spent > 0n ? fee : 0n),
        status: tx.status.confirmed ? 'confirmed' : 'pending',
        kind: 'transfer',
      };
      if (spent > 0n) item.fee = fee;
      if (counterparty) item.counterparty = counterparty;
      if (tx.status.block_time) item.time = tx.status.block_time * 1000;
      items.push(item);
    }
    return items.sort((a, b) => (b.time ?? Infinity) - (a.time ?? Infinity));
  }
}
