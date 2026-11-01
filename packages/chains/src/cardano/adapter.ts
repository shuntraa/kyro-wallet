// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cardano adapter (ADA + native tokens). Thin on purpose: reads, payment building (UTxOs and
// protocol parameters from Koios, coin selection, fee and min-UTxO by Rust, CBOR by
// wallet-core), signature and `submittx` are Rust commands (`ada_*`, docs/IPC.md §2.7). This
// adapter only validates input and checks that what Rust built is what was asked.

import { accountArg } from '../types';
import {
  call,
  type CardanoAccount,
  type CardanoAddressInfo,
  type CardanoContext,
  type CardanoHistoryEntry,
  type CardanoOutputView,
  type CardanoTokenBalance,
  type CardanoTokenSpec,
  type CardanoTokenView,
  type CardanoTxSummary,
  type CardanoWarning, l10n } from '@kyro/shared';
import type { CardanoChain } from '../registry';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';

// ---------------------------------------------------------------- Rust contract (§2.7)

export type {
  CardanoAccount,
  CardanoAddressInfo,
  CardanoContext,
  CardanoHistoryEntry,
  CardanoOutputView,
  CardanoTokenBalance,
  CardanoTokenSpec,
  CardanoTokenView,
  CardanoTxSummary,
  CardanoWarning,
};

export interface CardanoBackend {
  address(index: number): Promise<CardanoAddressInfo>;
  account(address: string): Promise<CardanoAccount>;
  txs(address: string): Promise<CardanoHistoryEntry[]>;
  build(to: string, lovelace?: string, token?: CardanoTokenSpec, memo?: string): Promise<{ tx: string; summary: CardanoTxSummary; context: CardanoContext }>;
  sign(tx: string, password: string): Promise<{ tx: string; txId: string; summary: CardanoTxSummary; context: CardanoContext }>;
  broadcast(tx: string): Promise<string>;
  txStatus(hash: string): Promise<{ confirmations: number | null }>;
}

/** The typed `ada_*` commands of `@kyro/shared` (docs/IPC.md §2.7), for vault account `account`. */
export function rustCardanoBackend(account = 0): CardanoBackend {
  const acct = accountArg(account);
  return {
    address: (index) => call('ada_address', { index, ...acct }),
    account: (address) => call('ada_account', { address }),
    txs: (address) => call('ada_txs', { address }),
    build: (to, lovelace, token, memo) => call('ada_build_tx', { to, ...(lovelace !== undefined ? { lovelace } : {}), ...(token ? { token } : {}), ...(memo ? { memo } : {}), ...acct }),
    sign: (tx, password) => call('ada_sign_tx', { tx, password, ...acct }),
    broadcast: (tx) => call('ada_broadcast', { tx, ...acct }),
    txStatus: (hash) => call('ada_tx_status', { hash }),
  };
}

// ---------------------------------------------------------------- addresses

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/**
 * Shape of a Shelley payment address for `network`: `addr1…` / `addr_test1…`, bech32 charset,
 * base (type 0 / 2) or enterprise (type 6) header. The checksum and every refusal (script,
 * pointer, reward, Byron, other network) are enforced by Rust (`cardano_address_bytes`).
 */
export function isCardanoAddress(address: string, network: 'mainnet' | 'testnet'): boolean {
  const a = address.trim().toLowerCase();
  const hrp = network === 'mainnet' ? 'addr1' : 'addr_test1';
  if (!a.startsWith(hrp) || a !== address.trim()) return false;
  const data = a.slice(hrp.length);
  if (![...data].every((c) => BECH32.includes(c))) return false;
  // The first data character carries the header's type nibble and one network bit:
  // q (type 0), y (2), v (6) with network bit 0; z / x / w are scripts, refused.
  const kind = BECH32.indexOf(data[0] ?? '?') >> 1;
  // Base (57 bytes → 92 characters) or enterprise (29 bytes → 47), plus a 6-character checksum.
  return (kind === 0 || kind === 2 || kind === 6) && (data.length === 92 + 6 || data.length === 47 + 6);
}

/**
 * Why an address is refused, in Rust's words (wallet-core `cardano_address_bytes`), or null when
 * its shape is acceptable. Read from the bech32 prefix and the header's type nibble (first data
 * character); the checksum itself is verified by Rust.
 */
export function cardanoAddressProblem(address: string, network: 'mainnet' | 'testnet'): string | null {
  const a = address.trim();
  if (!a) return null;
  if (isByronAddress(a) || /^(Ae2|DdzFF|37btjrVyb4K)/.test(a)) return l10n('les adresses Byron ne sont pas prises en charge : demande au destinataire une adresse Shelley (addr1…)', 'Byron addresses are not supported: ask the recipient for a Shelley address (addr1…)');
  const lower = a.toLowerCase();
  const pay = network === 'mainnet' ? 'addr1' : 'addr_test1';
  const stake = network === 'mainnet' ? 'stake1' : 'stake_test1';
  if (lower.startsWith(stake)) return l10n('une adresse de staking (stake…) ne peut pas recevoir de paiement', 'a staking address (stake…) cannot receive payments');
  if (lower.startsWith(network === 'mainnet' ? 'addr_test1' : 'addr1') || lower.startsWith(network === 'mainnet' ? 'stake_test1' : 'stake1')) return l10n("adresse Cardano d'un autre réseau, ou pas une adresse de paiement", 'Cardano address from another network, or not a payment address');
  if (!lower.startsWith(pay)) return l10n('adresse Cardano invalide', 'invalid Cardano address');
  const kind = BECH32.indexOf(lower[pay.length] ?? '?') >> 1;
  if (kind === 1 || kind === 3 || kind === 5 || kind === 7) return l10n('adresses de script refusées : un paiement sans datum pourrait bloquer les fonds', 'script addresses refused: a payment without a datum could lock the funds');
  if (kind === 4) return l10n('adresses pointeur obsolètes (Conway) : refusées', 'pointer addresses are obsolete (Conway): refused');
  if (kind === 14 || kind === 15) return l10n('une adresse de staking (stake…) ne peut pas recevoir de paiement', 'a staking address (stake…) cannot receive payments');
  return isCardanoAddress(a, network) ? null : 'adresse Cardano invalide';
}

/** Display name of a native token: ticker (verified), printable name, else the hex. */
export function cardanoTokenLabel(t: { name: string; nameText: string | null; ticker?: string }): string {
  return t.ticker ?? t.nameText ?? (t.name ? `0x${t.name.slice(0, 16)}${t.name.length > 16 ? '…' : ''}` : l10n('(nom vide)', '(empty name)'));
}

/** Byron (bootstrap) addresses: refused by Kyro, the UI says why. */
export function isByronAddress(address: string): boolean {
  const a = address.trim();
  return /^(Ae2|DdzFF|37btjrVyb4K)[1-9A-HJ-NP-Za-km-z]+$/.test(a);
}

/** "1,5" / "1.5" ADA → lovelace (6 decimals), exact. */
export function adaToLovelace(input: string): bigint {
  const s = input.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(l10n('Montant ADA invalide (6 décimales max.)', 'Invalid ADA amount (6 decimals max.)'));
  const [i, f = ''] = s.split('.');
  return BigInt(i ?? '0') * 1_000_000n + BigInt((f + '000000').slice(0, 6));
}

// ---------------------------------------------------------------- adapter

export interface CardanoUnsigned {
  family: 'ada';
  tx: string;
  summary: CardanoTxSummary;
  context: CardanoContext;
  recipient: string;
  /** Lovelace in the recipient output (with a token: its min-UTxO). */
  amount: bigint;
  token?: CardanoTokenSpec;
  memo?: string;
  maxFee: bigint;
  size: { family: 'ada' };
}

export interface CardanoSigned {
  family: 'ada';
  tx: string;
  txId: string;
  summary: CardanoTxSummary;
}

export interface CardanoAdapterOptions {
  chain: CardanoChain;
  address: string;
  backend?: CardanoBackend;
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
}

export class CardanoAdapter implements ChainAdapter<'ada'> {
  readonly family = 'ada' as const;
  readonly chain: CardanoChain;
  private readonly address: string;
  private readonly backend: CardanoBackend;

  constructor(opts: CardanoAdapterOptions) {
    if (!isCardanoAddress(opts.address, opts.chain.network)) throw new Error(l10n('Adresse Cardano invalide', 'Invalid Cardano address'));
    this.chain = opts.chain;
    this.address = opts.address;
    this.backend = opts.backend ?? rustCardanoBackend(opts.account ?? 0);
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return isCardanoAddress(address, this.chain.network);
  }

  account(): Promise<CardanoAccount> {
    return this.backend.account(this.address);
  }

  /** `ChainAdapter`: the ADA balance (native tokens: `balances()`). */
  async getBalance(): Promise<Balance[]> {
    const acc = await this.backend.account(this.address);
    return [{ assetId: 'ada', amount: BigInt(acc.balance) }];
  }

  /** No fee to choose: Rust computes min_fee_a × size + min_fee_b (≈ 0,17 ADA). */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'ada' as const };
    const eta = this.chain.blockTimeSecs;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: l10n('frais calculés par le coffre (≈ 0,17 ADA)', 'fees computed by the vault (≈ 0.17 ADA)'),
      fetchedAt: Date.now(),
    });
  }

  /**
   * `ChainAdapter` entry point. `cardanoToken`: a native token (its output carries exactly its
   * min-ADA). `max` (ADA): everything except the fee and the change output Rust always keeps
   * (its min-UTxO, plus every token), built until it fits.
   */
  async buildTx(params: BuildParams): Promise<CardanoUnsigned> {
    if (params.asset.kind !== 'native') throw new Error(l10n('Actif Cardano inattendu', 'Unexpected Cardano asset'));
    const memo = params.memo?.trim() ? { memo: params.memo.trim() } : {};
    if (params.cardanoToken) return this.buildPayment({ to: params.to, token: params.cardanoToken, ...memo });
    if (!params.max) return this.buildPayment({ to: params.to, lovelace: params.amount, ...memo });
    const acc = await this.backend.account(this.address);
    const balance = BigInt(acc.balance);
    const probe = await this.buildPayment({ to: params.to, lovelace: 1_500_000n, ...memo });
    const change = probe.summary.outputs.find((o) => o.isChange);
    let amount = balance - BigInt(probe.summary.fee) - BigInt(change?.minLovelace ?? '1000000');
    // Sending everything pulls every UTxO in: the change then carries all the tokens and needs a
    // larger min-UTxO. Rust's refusal gives both numbers; step down by the shortfall.
    const toLovelace = (s: string) => adaToLovelace(s);
    for (let i = 0; i < 5; i++) {
      if (amount <= 0n) break;
      try {
        return await this.buildPayment({ to: params.to, lovelace: amount, ...memo });
      } catch (e) {
        if (i === 4) throw e;
        const m = /\(([\d,]+) ADA\) serait sous son minimum de ([\d,]+) ADA/.exec(e instanceof Error ? e.message : String(e));
        const shortfall = m?.[1] && m[2] ? toLovelace(m[2]) - toLovelace(m[1]) : 0n;
        amount -= shortfall > 0n ? shortfall : 10_000n;
      }
    }
    throw new Error(l10n('Solde trop faible : Kyro garde toujours une sortie de monnaie (≈ 1 ADA minimum)', 'Balance too low: Kyro always keeps a change output (≈ 1 ADA minimum)'));
  }

  /** ADA balance (`spendable` = balance − ADA tied to the tokens) and native tokens. */
  async balances(): Promise<{ ada: { amount: bigint; spendable: bigint }; tokens: CardanoTokenBalance[] }> {
    const acc = await this.backend.account(this.address);
    const amount = BigInt(acc.balance);
    return { ada: { amount, spendable: amount - BigInt(acc.lockedWithTokens) }, tokens: acc.tokens };
  }

  /**
   * Builds a payment. `lovelace` omitted with a token = the min-UTxO the output needs. Rust
   * re-checks everything; this checks that what came back is what was asked.
   */
  async buildPayment(params: { to: string; lovelace?: bigint; token?: CardanoTokenSpec; memo?: string }): Promise<CardanoUnsigned> {
    const to = params.to.trim();
    if (isByronAddress(to)) throw new Error(l10n('Adresse Byron refusée : demande une adresse Shelley (addr1…)', 'Byron address refused: ask for a Shelley address (addr1…)'));
    if (!isCardanoAddress(to, this.chain.network)) throw new Error(l10n('Adresse Cardano invalide', 'Invalid Cardano address'));
    if (params.lovelace === undefined && !params.token) throw new Error(l10n('Montant ADA manquant', 'ADA amount missing'));
    if (params.lovelace !== undefined && params.lovelace <= 0n) throw new Error(l10n('Montant ADA invalide', 'Invalid ADA amount'));
    if (params.memo !== undefined && new TextEncoder().encode(params.memo).length > 1024) throw new Error(l10n('Message trop long (1 024 octets max.)', 'Message too long (1,024 bytes max.)'));
    const built = await this.backend.build(to, params.lovelace?.toString(), params.token, params.memo);
    const s = built.summary;
    const dest = s.outputs.find((o) => !o.isChange || o.address === to);
    const tokensOk = params.token
      ? dest?.tokens.length === 1 && dest.tokens[0]?.policy === params.token.policy.toLowerCase() && dest.tokens[0]?.name === params.token.name.toLowerCase() && dest.tokens[0]?.quantity === params.token.quantity
      : dest?.tokens.length === 0;
    const amountOk = params.lovelace === undefined ? dest?.lovelace === dest?.minLovelace : dest?.lovelace === params.lovelace.toString();
    const memoOk = (s.memo?.join('') ?? '') === (params.memo?.trim() ?? '');
    const changeOk = s.outputs.every((o) => o === dest || o.isChange);
    if (!dest || dest.address !== to || !tokensOk || !amountOk || !memoOk || !changeOk || s.outputs.length > 2) {
      throw new Error(l10n('La transaction construite par Rust ne correspond pas à la demande', 'The transaction built by Rust does not match the request'));
    }
    return {
      family: 'ada',
      tx: built.tx,
      summary: s,
      context: built.context,
      recipient: to,
      amount: BigInt(dest.lovelace),
      ...(params.token ? { token: params.token } : {}),
      ...(params.memo ? { memo: params.memo } : {}),
      maxFee: BigInt(s.fee),
      size: { family: 'ada' },
    };
  }

  /** Rust: live checks, native dialog (each output, tokens, min-ADA, fee, ttl), signature. */
  async signTx(unsigned: CardanoUnsigned, password: string): Promise<CardanoSigned> {
    const res = await this.backend.sign(unsigned.tx, password);
    if (!/^[0-9a-f]{64}$/.test(res.txId) || res.txId !== unsigned.summary.txId) throw new Error(l10n('Identifiant de transaction Cardano inattendu', 'Unexpected Cardano transaction ID'));
    return { family: 'ada', tx: res.tx, txId: res.txId, summary: res.summary };
  }

  /** Rust verifies the witness and that Koios answers our tx id. */
  async broadcast(signed: CardanoSigned): Promise<string> {
    const id = await this.backend.broadcast(signed.tx);
    if (id !== signed.txId) throw new Error(l10n('Identifiant diffusé inattendu', 'Unexpected broadcast ID'));
    return id;
  }

  txStatus(hash: string): Promise<{ confirmations: number | null }> {
    return this.backend.txStatus(hash);
  }

  /** `ChainAdapter`: ADA movements; tokens and the CIP-20 message go in `note`. */
  async getHistory(): Promise<HistoryItem[]> {
    const list = await this.historyEntries();
    return list.map((t) => {
      const parts = t.tokenDeltas.map((d) => `${d.delta.startsWith('-') ? '−' : '+'}${d.delta.replace('-', '')} ${d.nameText ?? (d.name ? `0x${d.name.slice(0, 12)}…` : 'token')}`);
      if (t.memo) parts.push(`« ${t.memo} »`);
      const item: HistoryItem = { id: t.id, chainKey: this.chain.key, assetId: 'ada', direction: t.direction, amount: t.amount, status: 'confirmed', kind: 'transfer' };
      if (t.fee !== undefined) item.fee = t.fee;
      if (t.time) item.time = t.time;
      if (parts.length) item.note = parts.join(' · ');
      return item;
    });
  }

  /** Rich history: signed ADA delta, token deltas, CIP-20 message. */
  async historyEntries(): Promise<Array<{ id: string; direction: 'in' | 'out'; amount: bigint; fee?: bigint; time?: number; memo?: string; tokenDeltas: CardanoHistoryEntry['tokenDeltas'] }>> {
    const list = await this.backend.txs(this.address);
    return list.map((t) => {
      const delta = BigInt(t.lovelaceDelta);
      const out = delta < 0n;
      return {
        id: t.hash,
        direction: out ? 'out' : 'in',
        amount: out ? -delta : delta,
        ...(out ? { fee: BigInt(t.fee || '0') } : {}),
        ...(t.time ? { time: t.time } : {}),
        ...(t.memo ? { memo: t.memo } : {}),
        tokenDeltas: t.tokenDeltas,
      };
    });
  }
}
