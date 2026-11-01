// SPDX-License-Identifier: GPL-3.0-or-later
// Generic single-account UTXO adapter for Bitcoin-derived chains other than Bitcoin (phase 4: Litecoin BIP84 P2WPKH; Dogecoin, Bitcoin Cash and Dash BIP44 P2PKH).

import { accountArg } from '../types';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import type { HDKey } from '@scure/bip32';
import { BTC_TXS_CAP, call, type EsploraAddressInfo, type EsploraTx, type EsploraUtxo, type Network, type UtxoAccountInfo, type UtxoFeeRates, type UtxoPrefix, type UtxoTxSummary, l10n } from '@kyro/shared';
import type { UtxoChain } from '../registry';
import type { Balance, BtcSigned, BtcUnsigned, BuildParams, FeeEstimates, HistoryItem } from '../types';
import { derivePubkey, fingerprintBytes, parseXpub } from '../bitcoin/xpub';
import type { HwSigner } from '../hw';

bitcoin.initEccLib(ecc);


/** One chain's account, as returned by `accounts_get` (`ltc`, `doge`, `bch`, `dash`). */
export type UtxoAccountView = UtxoAccountInfo;
export type { UtxoFeeRates, UtxoTxSummary, UtxoWarning } from '@kyro/shared';

/** What the adapter needs from Rust: one method per `{prefix}_*` command. */
export interface UtxoBackend {
  addressInfo(address: string): Promise<EsploraAddressInfo>;
  addressUtxos(address: string): Promise<EsploraUtxo[]>;
  addressTxs(address: string): Promise<EsploraTx[]>;
  txHex(txid: string): Promise<string>;
  feeRates(): Promise<UtxoFeeRates>;
  tipHeight(): Promise<number>;
  broadcast(hex: string): Promise<string>;
  signPsbt(psbt: string, password: string): Promise<{ psbt: string; summary: UtxoTxSummary }>;
}

/** The typed `{ltc,doge,bch,dash}_*` commands of `@kyro/shared` (docs/IPC.md §2.4), signing with vault account `account`. */
export function rustUtxoBackend(prefix: UtxoPrefix, account = 0): UtxoBackend {
  const acct = accountArg(account);
  return {
    addressInfo: (address) => call(`${prefix}_address_info`, { address }),
    addressUtxos: (address) => call(`${prefix}_address_utxos`, { address }),
    addressTxs: (address) => call(`${prefix}_address_txs`, { address }),
    txHex: (txid) => call(`${prefix}_tx_hex`, { txid }),
    feeRates: () => call(`${prefix}_fee_rates`),
    tipHeight: async () => Number(await call(`${prefix}_tip_height`)),
    broadcast: (hex) => call(`${prefix}_broadcast`, { hex }),
    signPsbt: (psbt, password) => call(`${prefix}_sign_psbt`, { psbt, password, ...acct }),
  };
}


export type UtxoScriptType = 'p2wpkh' | 'p2wsh' | 'p2tr' | 'p2pkh' | 'p2sh';

/** Script type of an output script (null: not a standard address script). */
export function scriptTypeOf(script: Uint8Array): UtxoScriptType | null {
  const n = script.length;
  if (n === 22 && script[0] === 0x00 && script[1] === 0x14) return 'p2wpkh';
  if (n === 34 && script[0] === 0x00 && script[1] === 0x20) return 'p2wsh';
  if (n === 34 && script[0] === 0x51 && script[1] === 0x20) return 'p2tr';
  if (n === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac) return 'p2pkh';
  if (n === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) return 'p2sh';
  return null;
}

/** Output sizes in bytes (8 value + 1 length + script). */
export const OUTPUT_BYTES: Record<UtxoScriptType, number> = { p2wpkh: 31, p2wsh: 43, p2tr: 43, p2pkh: 34, p2sh: 32 };

/** Size model, identical to Rust's worst-case estimate (wallet-core `utxo.rs`): P2WPKH input = 41 bytes + 108 WU witness = 68 vB, overhead 10.5 vB (with marker/flag); P2PKH input = 41 + 107 (scriptSig) = 148 bytes, overhead 10 bytes. */
export interface SizeModel {
  overhead: number;
  input: number;
}

export interface CoinSelection {
  inputs: SelectableCoin[];
  amount: bigint;
  /** 0n when there is no change output. */
  change: bigint;
  fee: bigint;
  /** Remainder too small for a change output, added to the fee (0n otherwise). */
  dustFolded: bigint;
  vsize: number;
}

export interface SelectableCoin {
  txid: string;
  vout: number;
  value: bigint;
}

export class UtxoInsufficientFundsError extends Error {
  readonly needed: bigint;
  readonly available: bigint;
  constructor(needed: bigint, available: bigint) {
    super(l10n('Solde insuffisant pour couvrir le montant et les frais.', 'Insufficient balance to cover the amount and the fees.'));
    this.name = 'UtxoInsufficientFundsError';
    this.needed = needed;
    this.available = available;
  }
}

export function estimateSize(model: SizeModel, inputs: number, outputs: UtxoScriptType[]): number {
  return Math.ceil(model.overhead + inputs * model.input + outputs.reduce((s, t) => s + OUTPUT_BYTES[t], 0));
}

const feeFor = (vsize: number, rate: number) => BigInt(Math.ceil(vsize * rate));

/** Largest-first selection. */
export function selectUtxoCoins(
  coins: SelectableCoin[],
  target: bigint,
  rate: number,
  recipient: UtxoScriptType,
  change: UtxoScriptType,
  model: SizeModel,
  minOutput: (t: UtxoScriptType) => bigint,
  unit: string,
): CoinSelection {
  if (target <= 0n) throw new Error(l10n('Montant invalide', 'Invalid amount'));
  if (target < minOutput(recipient)) throw new Error(l10n(`Montant sous le seuil de poussière (${minOutput(recipient)} ${unit})`, `Amount below the dust threshold (${minOutput(recipient)} ${unit})`));
  const sorted = [...coins].sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));
  const chosen: SelectableCoin[] = [];
  let sum = 0n;
  for (const c of sorted) {
    chosen.push(c);
    sum += c.value;
    const withChange = estimateSize(model, chosen.length, [recipient, change]);
    const feeChange = feeFor(withChange, rate);
    if (sum >= target + feeChange && sum - target - feeChange >= minOutput(change)) {
      return { inputs: chosen, amount: target, change: sum - target - feeChange, fee: feeChange, dustFolded: 0n, vsize: withChange };
    }
    const noChange = estimateSize(model, chosen.length, [recipient]);
    const feeNoChange = feeFor(noChange, rate);
    if (sum >= target + feeNoChange) {
      return { inputs: chosen, amount: target, change: 0n, fee: sum - target, dustFolded: sum - target - feeNoChange, vsize: noChange };
    }
  }
  throw new UtxoInsufficientFundsError(target + feeFor(estimateSize(model, sorted.length, [recipient]), rate), sum);
}

/** Every coin to one output (MAX). */
export function selectAllUtxoCoins(coins: SelectableCoin[], rate: number, recipient: UtxoScriptType, model: SizeModel, minOutput: (t: UtxoScriptType) => bigint): CoinSelection {
  const sum = coins.reduce((s, c) => s + c.value, 0n);
  const vsize = estimateSize(model, coins.length, [recipient]);
  const fee = feeFor(vsize, rate);
  const amount = sum - fee;
  if (coins.length === 0 || amount < minOutput(recipient)) throw new UtxoInsufficientFundsError(fee + minOutput(recipient), sum);
  return { inputs: [...coins], amount, change: 0n, fee, dustFolded: 0n, vsize };
}


export interface UtxoCoinSpec {
  /** Command prefix and asset id. */
  prefix: UtxoPrefix;
  /** Our receive/change script type. */
  own: 'p2wpkh' | 'p2pkh';
  network: (n: Network) => bitcoin.Network;
  model: SizeModel;
  minOutput: (t: UtxoScriptType) => bigint;
  /** Legacy inputs: the PSBT must carry the full previous transaction (`nonWitnessUtxo`). */
  needsPrevTx: boolean;
  /** Smallest-unit name, for messages. */
  unit: string;
  /** Floor of the fee rate (smallest unit per vB) and its display. */
  minRate: number;
  rateHint: (rate: number) => string;
  /** Extra address check (e.g. Dogecoin: base58 only). */
  acceptAddress?: (address: string, net: bitcoin.Network) => boolean;
  /** Address codec when bitcoinjs's is not the chain's (Bitcoin Cash: CashAddr). */
  codec?: {
    toScript: (address: string, network: Network) => Uint8Array;
    toAddress: (script: Uint8Array, network: Network) => string | null;
  };
}

export interface DerivedUtxoAddress {
  change: 0 | 1;
  index: number;
  address: string;
  pubkey: Uint8Array;
  path: string;
  used: boolean;
  balance: bigint;
}

export interface UtxoAdapterOptions {
  chain: UtxoChain;
  account: UtxoAccountView;
  backend?: UtxoBackend;
  gapLimit?: number;
  /** Vault account index (docs/IPC.md §2.9) passed to `*_sign_psbt`; absent = 0. (`account` is the xpub view.) */
  vaultAccount?: number;
  /** Hardware-wallet account: signing through `hw_sign_utxo_psbt` (every input carries its previous transaction). */
  hw?: HwSigner;
}

/** Address `xpub/change/index` of a chain (same derivation as [`UtxoAdapter.addressAt`]). */
export function utxoAddressFromXpub(spec: UtxoCoinSpec, network: Network, xpub: string, change: 0 | 1 = 0, index = 0): string {
  const net = spec.network(network);
  const pubkey = derivePubkey(parseXpub(xpub), change, index);
  const payment = spec.own === 'p2wpkh' ? bitcoin.payments.p2wpkh({ pubkey, network: net }) : bitcoin.payments.p2pkh({ pubkey, network: net });
  const address = spec.codec && payment.output ? spec.codec.toAddress(payment.output, network) : payment.address;
  if (!address) throw new Error(l10n('Adresse introuvable', 'Address not found'));
  return address;
}

/** Local build result: the Bitcoin shapes plus what was folded into the fee. */
export interface UtxoUnsigned extends BtcUnsigned {
  /** Remainder below the dust limit added to the fee (Rust's dialog says « pas de monnaie »). */
  dustFolded: bigint;
}

export interface UtxoSigned extends BtcSigned {
  /** Rust's decoding, shown in the native dialog before signing. */
  summary: UtxoTxSummary;
}

const SCAN_TTL_MS = 30_000;
const MAX_SCAN = 40;

export class UtxoAdapter {
  readonly family: UtxoPrefix;
  readonly chain: UtxoChain;
  readonly assetId: string;
  readonly spec: UtxoCoinSpec;
  readonly net: bitcoin.Network;
  private readonly backend: UtxoBackend;
  private readonly key: HDKey;
  private readonly account: UtxoAccountView;
  private readonly gap: number;
  readonly hw: HwSigner | null;
  private scanCache: { at: number; addrs: DerivedUtxoAddress[] } | null = null;
  private scanning: Promise<DerivedUtxoAddress[]> | null = null;
  /** True when one address hit the 50-transaction cap: older ones are not shown. */
  historyCapped = false;

  constructor(spec: UtxoCoinSpec, opts: UtxoAdapterOptions) {
    this.spec = spec;
    this.chain = opts.chain;
    this.family = opts.chain.family;
    this.assetId = spec.prefix;
    this.account = opts.account;
    this.net = spec.network(opts.chain.network);
    this.backend = opts.backend ?? rustUtxoBackend(spec.prefix, opts.vaultAccount ?? 0);
    this.gap = opts.gapLimit ?? 5;
    this.hw = opts.hw ?? null;
    this.key = parseXpub(opts.account.xpub);
    const first = this.addressAt(0, 0);
    if (first.address !== opts.account.address) {
      throw new Error(l10n(`Dérivation ${opts.chain.name} incohérente avec le coffre (${first.address} ≠ ${opts.account.address})`, `${opts.chain.name} derivation inconsistent with the vault (${first.address} ≠ ${opts.account.address})`));
    }
  }

  getAddress(): string {
    return this.account.address;
  }

  /** scriptPubKey of an address of this chain (throws if invalid for this chain and network). */
  scriptOf(address: string): Uint8Array {
    const a = address.trim();
    return this.spec.codec ? this.spec.codec.toScript(a, this.chain.network) : bitcoin.address.toOutputScript(a, this.net);
  }

  isValidAddress(address: string): boolean {
    const a = address.trim();
    try {
      const script = this.scriptOf(a);
      if (!scriptTypeOf(script)) return false;
      return this.spec.acceptAddress ? this.spec.acceptAddress(a, this.net) : true;
    } catch {
      return false;
    }
  }

  addressAt(change: 0 | 1, index: number): DerivedUtxoAddress {
    const pubkey = derivePubkey(this.key, change, index);
    const payment = this.spec.own === 'p2wpkh' ? bitcoin.payments.p2wpkh({ pubkey, network: this.net }) : bitcoin.payments.p2pkh({ pubkey, network: this.net });
    const address = this.spec.codec && payment.output ? this.spec.codec.toAddress(payment.output, this.chain.network) : payment.address;
    if (!address) throw new Error(l10n('Adresse introuvable', 'Address not found'));
    return { change, index, address, pubkey, path: `${this.account.path}/${change}/${index}`, used: false, balance: 0n };
  }

  /** Gap-limit scan of the receive and change branches. Cached 30 s. */
  async scan(force = false): Promise<DerivedUtxoAddress[]> {
    if (!force && this.scanCache && Date.now() - this.scanCache.at < SCAN_TTL_MS) return this.scanCache.addrs;
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const out: DerivedUtxoAddress[] = [];
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

  async estimateFees(): Promise<FeeEstimates> {
    const f = await this.backend.feeRates();
    const min = Math.max(this.spec.minRate, f.minimumFee);
    const slow = Math.max(min, f.hourFee);
    const normal = Math.max(slow, f.halfHourFee);
    const fast = Math.max(normal, f.fastestFee);
    const block = this.chain.blockTimeSecs;
    return {
      options: {
        slow: { level: 'slow', params: { family: 'btc', satPerVb: slow }, etaSecs: block * 6 },
        normal: { level: 'normal', params: { family: 'btc', satPerVb: normal }, etaSecs: block * 3 },
        fast: { level: 'fast', params: { family: 'btc', satPerVb: fast }, etaSecs: block },
      },
      minimum: { family: 'btc', satPerVb: min },
      hint: this.spec.rateHint(normal),
      fetchedAt: Date.now(),
    };
  }

  private async coins(): Promise<Array<SelectableCoin & { owner: DerivedUtxoAddress }>> {
    const addrs = (await this.scan()).filter((a) => a.used);
    const lists = await Promise.all(
      addrs.map(async (owner) => {
        const list = await this.backend.addressUtxos(owner.address);
        return list.map((u) => {
          // JSON numbers above 2^53 lose precision in JS (≈ 90 M DOGE in one output).
          if (!Number.isSafeInteger(u.value) || u.value < 0) throw new Error(l10n('Montant de sortie hors limites (trop grand pour être lu sans perte)', 'Output amount out of range (too large to read without loss)'));
          return { txid: u.txid, vout: u.vout, value: BigInt(u.value), owner };
        });
      }),
    );
    return lists.flat();
  }

  private async changeAddress(): Promise<DerivedUtxoAddress> {
    const known = (await this.scan()).filter((a) => a.change === 1);
    for (let i = 0; i < MAX_SCAN; i++) {
      const k = known.find((a) => a.index === i);
      if (!k || !k.used) return this.addressAt(1, i);
    }
    return this.addressAt(1, MAX_SCAN);
  }

  async buildTx(params: BuildParams): Promise<UtxoUnsigned> {
    if (params.fee.family !== 'btc') throw new Error(l10n('Frais attendus en unité par vbyte', 'Fees expected per vbyte'));
    if (params.asset.id !== this.assetId) throw new Error(l10n('Actif incohérent avec cette chaîne', 'Asset inconsistent with this chain'));
    const rate = params.fee.satPerVb;
    if (!(rate >= this.spec.minRate)) throw new Error(l10n(`Taux minimum : ${this.spec.rateHint(this.spec.minRate)}`, `Minimum rate: ${this.spec.rateHint(this.spec.minRate)}`));
    const to = params.to.trim();
    if (!this.isValidAddress(to)) throw new Error(l10n(`Adresse ${this.chain.nativeName} invalide pour ce réseau`, `Invalid ${this.chain.nativeName} address for this network`));
    const recipientScript = this.scriptOf(to);
    const recipientType = scriptTypeOf(recipientScript);
    if (!recipientType) throw new Error(l10n('Type d’adresse non pris en charge', 'Address type not supported'));
    const coins = await this.coins();
    const { model, minOutput } = this.spec;
    const sel = params.max
      ? selectAllUtxoCoins(coins, rate, recipientType, model, minOutput)
      : selectUtxoCoins(coins, params.amount, rate, recipientType, this.spec.own, model, minOutput, this.spec.unit);
    const fp = fingerprintBytes(this.account.fingerprint);
    const psbt = new bitcoin.Psbt({ network: this.net });
    const prevTx = new Map<string, Uint8Array>();
    // Hardware wallets check every spent amount against the full previous transaction.
    const withPrev = this.spec.needsPrevTx || this.hw !== null;
    if (withPrev) {
      for (const txid of new Set(sel.inputs.map((c) => c.txid))) {
        const tx = bitcoin.Transaction.fromHex(await this.backend.txHex(txid));
        if (tx.getId() !== txid) throw new Error(l10n('Transaction précédente incohérente', 'Inconsistent previous transaction'));
        prevTx.set(txid, tx.toBuffer());
      }
    }
    for (const c of sel.inputs) {
      const owner = (c as (typeof coins)[number]).owner;
      const derivation = [{ masterFingerprint: fp, pubkey: owner.pubkey, path: owner.path }];
      if (this.spec.needsPrevTx) {
        const raw = prevTx.get(c.txid);
        if (!raw) throw new Error(l10n('Transaction précédente manquante', 'Previous transaction missing'));
        psbt.addInput({ hash: c.txid, index: c.vout, nonWitnessUtxo: raw, bip32Derivation: derivation });
      } else if (withPrev) {
        const raw = prevTx.get(c.txid);
        if (!raw) throw new Error(l10n('Transaction précédente manquante', 'Previous transaction missing'));
        const script = this.scriptOf(owner.address);
        psbt.addInput({ hash: c.txid, index: c.vout, witnessUtxo: { script, value: c.value }, nonWitnessUtxo: raw, bip32Derivation: derivation });
      } else {
        const script = this.scriptOf(owner.address);
        psbt.addInput({ hash: c.txid, index: c.vout, witnessUtxo: { script, value: c.value }, bip32Derivation: derivation });
      }
    }
    psbt.addOutput({ script: recipientScript, value: sel.amount });
    const outputs: BtcUnsigned['summary']['outputs'] = [[to, Number(sel.amount), false]];
    if (sel.change > 0n) {
      const change = await this.changeAddress();
      psbt.addOutput({ script: this.scriptOf(change.address), value: sel.change, bip32Derivation: [{ masterFingerprint: fp, pubkey: change.pubkey, path: change.path }] });
      outputs.push([change.address, Number(sel.change), true]);
    }
    return {
      family: 'btc',
      psbt: psbt.toBase64(),
      amount: sel.amount,
      recipient: to,
      fee: sel.fee,
      maxFee: sel.fee,
      // Bitcoin's thresholds (100 sat/vB) do not apply to litoshis / koinus: Rust's own UtxoTxSummary warnings (ltc_/doge_sign_psbt) decide the reinforced confirmation.
      summary: { outputs, feeSats: Number(sel.fee), warnings: [], requiresExtraConfirmation: false },
      size: { family: 'btc', vsize: sel.vsize },
      dustFolded: sel.dustFolded,
    };
  }

  /** Rust: password, decoding, native dialog (+ reinforced one if needed), signature. */
  async signTx(unsigned: UtxoUnsigned, password: string): Promise<UtxoSigned> {
    return this.finish(unsigned, await this.backend.signPsbt(unsigned.psbt, password));
  }

  /** Hardware wallet: Rust's decoding and dialog, the device, then every signature verified in Rust. */
  async signTxHw(unsigned: UtxoUnsigned, deviceId: string): Promise<UtxoSigned> {
    if (!this.hw) throw new Error(l10n('Ce compte n’est pas un hardware wallet', 'This account is not a hardware wallet'));
    const res = await call('hw_sign_utxo_psbt', { id: deviceId, accountId: this.hw.accountId, chain: this.spec.prefix, psbt: unsigned.psbt });
    return this.finish(unsigned, res);
  }

  private finish(unsigned: UtxoUnsigned, res: { psbt: string; summary: UtxoTxSummary }): UtxoSigned {
    if (BigInt(res.summary.fee) !== unsigned.fee) throw new Error(l10n('Les frais décodés par Rust diffèrent de ceux de la transaction construite', 'The fees decoded by Rust differ from those of the built transaction'));
    const psbt = bitcoin.Psbt.fromBase64(res.psbt, { network: this.net });
    // Bitcoin Cash: Rust returns the inputs finalized (FORKID signatures); the others are finalized here from Rust's partial signatures.
    const finalized = psbt.data.inputs.every((i) => i.finalScriptWitness || i.finalScriptSig);
    if (!finalized) psbt.finalizeAllInputs();
    // The fee was shown and approved in Rust's dialog: no extra bitcoinjs fee-rate limit here (its default is in sat/vB for Bitcoin, meaningless for koinus).
    const tx = psbt.extractTransaction(true);
    return { family: 'btc', hex: tx.toHex(), txid: tx.getId(), summary: res.summary };
  }

  /** Rust checks that the server's txid matches the transaction. */
  async broadcast(signed: BtcSigned): Promise<string> {
    return (await this.backend.broadcast(signed.hex)).trim() || signed.txid;
  }

  async getHistory(): Promise<HistoryItem[]> {
    const addrs = (await this.scan()).filter((a) => a.used);
    const own = new Set(addrs.map((a) => a.address));
    const lists = await Promise.all(addrs.map((a) => this.backend.addressTxs(a.address)));
    this.historyCapped = lists.some((l) => l.length >= BTC_TXS_CAP);
    const seen = new Map<string, EsploraTx>();
    for (const list of lists) for (const tx of list) seen.set(tx.txid, tx);
    const items: HistoryItem[] = [];
    for (const tx of seen.values()) {
      const spent = tx.vin.reduce((s, i) => s + (i.prevout?.scriptpubkey_address && own.has(i.prevout.scriptpubkey_address) ? BigInt(i.prevout.value) : 0n), 0n);
      const received = tx.vout.reduce((s, o) => s + (o.scriptpubkey_address && own.has(o.scriptpubkey_address) ? BigInt(o.value) : 0n), 0n);
      const fee = BigInt(tx.fee ?? 0);
      const external = tx.vout.find((o) => !o.scriptpubkey_address || !own.has(o.scriptpubkey_address));
      const sender = tx.vin.find((i) => i.prevout?.scriptpubkey_address && !own.has(i.prevout.scriptpubkey_address))?.prevout?.scriptpubkey_address;
      const direction = spent === 0n ? 'in' : external ? 'out' : 'self';
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
      if (spent > 0n) item.fee = fee;
      if (counterparty) item.counterparty = counterparty;
      if (tx.status.block_time) item.time = tx.status.block_time * 1000;
      items.push(item);
    }
    return items.sort((a, b) => (b.time ?? Infinity) - (a.time ?? Infinity));
  }
}
