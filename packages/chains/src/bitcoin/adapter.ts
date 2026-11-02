// SPDX-License-Identifier: GPL-3.0-or-later
// Bitcoin adapter (BIP84 SegWit + BIP86 Taproot). Rust picks the server and never falls back to the default: this adapter never calls `net_fetch` for Bitcoin.

import { accountArg } from '../types';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import type { HDKey } from '@scure/bip32';
import { BTC_TXS_CAP, btcWarnings, call, type Accounts, type BtcKind, type BtcTxSummary, type EsploraTx, l10n } from '@kyro/shared';
import type { BtcChain } from '../registry';
import type { Balance, BtcSigned, BtcUnsigned, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';
import { outputTypeOf, selectAll, selectCoins, type SelectableUtxo, type Selection } from './coinselect';
import type { HwSigner } from '../hw';
import { derivePubkey, fingerprintBytes, parseXpub } from './xpub';
import { scriptTypeOf } from '../utxo/utxo';
import { gapScanBranch, limiter, SCAN_CONCURRENCY } from '../gapScan';

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
  /** Hardware-wallet account: input rules of the devices (docs/IPC.md §2.3). - every SegWit v0 input carries `non_witness_utxo`, the full previous transaction, from `prevTx` (`btc_tx_hex`: Rust checks its txid; bitcoinjs checks it again here); - Ledger: one kind of input per transaction (SegWit OR Taproot), never mixed. */
  hw?: HwSigner & { prevTx: (txid: string) => Promise<string> };
  /** Consecutive unused addresses before stopping a scan. */
  gapLimit?: number;
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
}

const SCAN_TTL_MS = 30_000;
const MAX_SCAN = 40;

export class BitcoinAdapter implements ChainAdapter<'btc'> {
  readonly family = 'btc' as const;
  readonly chain: BtcChain;
  private readonly net: bitcoin.Network;
  private readonly gap: number;
  private readonly accounts: Accounts['btc'];
  readonly hw: BitcoinAdapterOptions['hw'] | null;
  /** Vault account index (0 = the historical account). */
  readonly account: number;
  private readonly keys: Record<BtcKind, HDKey>;
  private scanCache: { at: number; addrs: DerivedAddress[] } | null = null;
  private scanning: Promise<DerivedAddress[]> | null = null;
  /** True when the last `getHistory` hit the cap (`BTC_TXS_CAP` transactions for at least one address, every backend): older ones may exist and are not shown. */
  historyCapped = false;

  constructor(opts: BitcoinAdapterOptions) {
    this.chain = opts.chain;
    this.accounts = opts.accounts;
    this.hw = opts.hw ?? null;
    this.account = opts.account ?? 0;
    this.net = opts.chain.network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
    this.gap = opts.gapLimit ?? 5;
    this.keys = { segwit: parseXpub(opts.accounts.segwit.xpub), taproot: parseXpub(opts.accounts.taproot.xpub) };
    // Sanity check: our derivation must match what Rust derived.
    for (const kind of ['segwit', 'taproot'] as const) {
      const first = this.addressAt(kind, 0, 0);
      if (first.address !== opts.accounts[kind].address) {
        throw new Error(l10n(`Dérivation ${kind} incohérente avec le coffre (${first.address} ≠ ${opts.accounts[kind].address})`, `${kind} derivation inconsistent with the vault (${first.address} ≠ ${opts.accounts[kind].address})`));
      }
    }
  }

  getAddress(kind: BtcKind = 'segwit'): string {
    return this.accounts[kind].address;
  }

  /** Only the five standard types: P2PKH, P2SH, P2WPKH, P2WSH, P2TR. */
  isValidAddress(address: string): boolean {
    try {
      return scriptTypeOf(bitcoin.address.toOutputScript(address.trim(), this.net)) !== null;
    } catch {
      return false;
    }
  }

  /** Public derivation of `kind/change/index`. */
  addressAt(kind: BtcKind, change: 0 | 1, index: number): DerivedAddress {
    const pubkey = derivePubkey(this.keys[kind], change, index);
    const payment = kind === 'segwit' ? bitcoin.payments.p2wpkh({ pubkey, network: this.net }) : bitcoin.payments.p2tr({ internalPubkey: pubkey.slice(1, 33), network: this.net });
    if (!payment.address) throw new Error(l10n('Adresse introuvable', 'Address not found'));
    return { kind, change, index, address: payment.address, pubkey, path: `${this.accounts[kind].path}/${change}/${index}`, used: false, balance: 0n };
  }

  /** Gap-limit scan of both kinds and both branches. Cached 30 s. */
  async scan(force = false): Promise<DerivedAddress[]> {
    if (!force && this.scanCache && Date.now() - this.scanCache.at < SCAN_TTL_MS) return this.scanCache.addrs;
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const branches: Array<[BtcKind, 0 | 1]> = [['segwit', 0], ['segwit', 1], ['taproot', 0], ['taproot', 1]];
      const run = limiter(SCAN_CONCURRENCY);
      const lists = await Promise.all(
        branches.map(([kind, change]) =>
          gapScanBranch(change === 0 ? this.gap : Math.max(2, this.gap - 2), MAX_SCAN, async (i) => {
            const d = this.addressAt(kind, change, i);
            const info = await call('btc_address_info', { address: d.address });
            const txs = info.chain_stats.tx_count + info.mempool_stats.tx_count;
            d.used = txs > 0;
            // Esplora: funded − spent.
            d.balance = BigInt(info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum + info.mempool_stats.funded_txo_sum - info.mempool_stats.spent_txo_sum);
            return d;
          }, run),
        ),
      );
      const out = lists.flat();
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
      ...(f.source === 'block-average' ? { source: 'block-average' as const } : {}),
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

  /** Candidate input sets. Ledger: never SegWit + Taproot in the same transaction (its Bitcoin app refuses mixed inputs), so one set per kind. */
  inputGroups<T extends { owner: { kind: BtcKind } }>(utxos: T[]): T[][] {
    if (!this.hw || this.hw.device === 'trezor') return [utxos];
    const groups = (['segwit', 'taproot'] as const).map((k) => utxos.filter((u) => u.owner.kind === k)).filter((g) => g.length > 0);
    return groups.length ? groups : [[]];
  }

  async buildTx(params: BuildParams): Promise<BtcUnsigned> {
    if (params.fee.family !== 'btc') throw new Error(l10n('Frais Bitcoin attendus', 'Bitcoin fees expected'));
    const to = params.to.trim();
    if (!this.isValidAddress(to)) throw new Error(l10n('Adresse Bitcoin invalide pour ce réseau', 'Invalid Bitcoin address for this network'));
    const utxos = await this.utxos();
    const recipientType = outputTypeOf(to);
    const feeRate = params.fee.satPerVb;
    let sel: Selection | null = null;
    let lastError: unknown = null;
    for (const group of this.inputGroups(utxos)) {
      try {
        const s = params.max ? selectAll(group, feeRate, recipientType) : selectCoins(group, params.amount, feeRate, recipientType, 'p2wpkh');
        // Max: the largest group wins; otherwise the cheapest.
        if (!sel || (params.max ? s.amount > sel.amount : s.fee < sel.fee)) sel = s;
      } catch (e) {
        lastError = e;
      }
    }
    if (!sel) {
      if (this.hw?.device === 'ledger' && utxos.some((u) => u.owner.kind === 'segwit') && utxos.some((u) => u.owner.kind === 'taproot')) {
        const total = utxos.reduce((s, u) => s + u.value, 0n);
        if (params.max || total >= params.amount) {
          throw new Error(
            l10n('Ledger : une transaction ne peut pas mélanger des entrées SegWit et Taproot, et aucun des deux soldes ne suffit seul. Envoie un montant plus petit, ou regroupe d’abord tes fonds sur un seul type d’adresse.', 'Ledger: a transaction cannot mix SegWit and Taproot inputs, and neither balance is enough on its own. Send a smaller amount, or first move your funds to a single address type.'),
          );
        }
      }
      throw lastError instanceof Error ? lastError : new Error(l10n('Sélection des entrées impossible', 'Input selection failed'));
    }
    const psbt = new bitcoin.Psbt({ network: this.net });
    for (const u of sel.inputs) {
      const owner = (u as (typeof utxos)[number]).owner;
      const fp = fingerprintBytes(this.accounts[owner.kind].fingerprint);
      const script = bitcoin.address.toOutputScript(owner.address, this.net);
      if (owner.kind === 'segwit') {
        const input: Parameters<typeof psbt.addInput>[0] = { hash: u.txid, index: u.vout, witnessUtxo: { script, value: u.value }, bip32Derivation: [{ masterFingerprint: fp, pubkey: owner.pubkey, path: owner.path }] };
        if (this.hw) {
          // Rust refuses a SegWit v0 input without its previous transaction (INVALID_INPUT) and checks its txid; checked here too (txid and the spent output), never trusted blindly.
          const prev = bitcoin.Transaction.fromHex(await this.hw.prevTx(u.txid));
          const out = prev.outs[u.vout];
          if (prev.getId() !== u.txid || !out || out.value !== u.value || !bytesEqual(out.script, script)) {
            throw new Error(l10n(`Transaction précédente incohérente pour l’entrée ${u.txid.slice(0, 10)}… : signature refusée.`, `Previous transaction inconsistent for input ${u.txid.slice(0, 10)}…: signing refused.`));
          }
          input.nonWitnessUtxo = prev.toBuffer();
        }
        psbt.addInput(input);
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
      // Same triggers as Rust's summary (it re-decodes before signing; this shows them earlier).
      summary: { outputs, feeSats: Number(sel.fee), ...btcWarnings({ outputs, feeSats: Number(sel.fee), vsize: sel.vsize }) },
      size: { family: 'btc', vsize: sel.vsize },
    };
  }

  async signTx(unsigned: BtcUnsigned, password: string): Promise<BtcSigned> {
    const res = await call('btc_sign_psbt', { psbt: unsigned.psbt, password, ...accountArg(this.account) });
    const psbt = bitcoin.Psbt.fromBase64(res.psbt, { network: this.net });
    const finalized = psbt.data.inputs.every((i) => i.finalScriptWitness || i.finalScriptSig);
    if (!finalized) psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    return { family: 'btc', hex: tx.toHex(), txid: tx.getId() };
  }

  /** Signs on the hardware wallet `deviceId` (no password: native dialog + device screen). */
  async signTxHw(unsigned: BtcUnsigned, deviceId: string): Promise<BtcSigned> {
    if (!this.hw) throw new Error(l10n('Ce compte n’est pas un hardware wallet', 'This account is not a hardware wallet'));
    const res = await call('hw_sign_btc_psbt', { id: deviceId, accountId: this.hw.accountId, psbt: unsigned.psbt });
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
