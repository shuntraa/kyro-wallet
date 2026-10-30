// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cardano adapter (ADA + native tokens). Thin on purpose: reads, payment building (UTxOs and
// protocol parameters from Koios, coin selection, fee and min-UTxO by Rust, CBOR by
// wallet-core), signature and `submittx` are Rust commands (`ada_*`, docs/IPC.md §2.7). This
// adapter only validates input and checks that what Rust built is what was asked.
//
// Not yet wired into `Family` / `ChainAdapter` / `createAdapters` / `@kyro/shared`'s typed
// `call` (those files belong to the UI work): the types of the `ada_*` commands live here
// until they move to `packages/shared/src/ipc.ts`. See docs/IPC.md §2.7 "À faire côté UI".

import { call } from '@kyro/shared';
import type { CardanoChain } from '../registry';

// ---------------------------------------------------------------- Rust contract (§2.7)

export interface CardanoTokenView {
  policy: string;
  /** Asset name, hex (may be empty). */
  name: string;
  /** Printable UTF-8 form of the name, else null. */
  nameText: string | null;
  quantity: string;
  verified: boolean;
}

export interface CardanoOutputView {
  address: string;
  kind: 'base' | 'enterprise';
  isChange: boolean;
  lovelace: string;
  tokens: CardanoTokenView[];
  /** Minimum lovelace this output must carry (min-UTxO). */
  minLovelace: string;
}

export type CardanoWarning =
  | { kind: 'memo' }
  | { kind: 'unknownToken'; policy: string; name: string }
  | { kind: 'highFee' }
  | { kind: 'noTtl' };

export interface CardanoTxSummary {
  txId: string;
  /** `txhash#index`. */
  inputs: string[];
  outputs: CardanoOutputView[];
  fee: string;
  ttl: number | null;
  validFrom: number | null;
  memo: string[] | null;
  warnings: CardanoWarning[];
  requiresExtraConfirmation: boolean;
}

export interface CardanoTokenBalance {
  policy: string;
  name: string;
  nameText: string | null;
  quantity: string;
  verified: boolean;
  ticker?: string;
  decimals?: number;
}

export interface CardanoAccount {
  address: string;
  /** Lovelace. */
  balance: string;
  tokens: CardanoTokenBalance[];
  utxoCount: number;
  /** Lovelace that the tokens tie up (their outputs' min-UTxO). */
  lockedWithTokens: string;
}

export interface CardanoContext {
  account: CardanoAccount;
  params: { minFeeA: number; minFeeB: number; coinsPerByte: number; maxTxSize: number };
  tip: { slot: number; blockHeight: number; epoch: number };
  /** Lovelace leaving the wallet: outputs to other addresses + fee. */
  leaving: string;
}

export interface CardanoHistoryEntry {
  hash: string;
  time: number | null;
  blockHeight: number | null;
  fee: string;
  /** Received − spent by our address, signed decimal lovelace. */
  lovelaceDelta: string;
  tokenDeltas: { policy: string; name: string; nameText: string | null; delta: string }[];
  memo: string | null;
}

export interface CardanoTokenSpec {
  policy: string;
  name: string;
  quantity: string;
}

export interface CardanoAddressInfo {
  address: string;
  path: string;
  stakeAddress: string;
  accountXpub: string;
}

export interface CardanoBackend {
  address(index: number): Promise<CardanoAddressInfo>;
  account(address: string): Promise<CardanoAccount>;
  txs(address: string): Promise<CardanoHistoryEntry[]>;
  build(to: string, lovelace?: string, token?: CardanoTokenSpec, memo?: string): Promise<{ tx: string; summary: CardanoTxSummary; context: CardanoContext }>;
  sign(tx: string, password: string): Promise<{ tx: string; txId: string; summary: CardanoTxSummary; context: CardanoContext }>;
  broadcast(tx: string): Promise<string>;
  txStatus(hash: string): Promise<{ confirmations: number | null }>;
}

/** `call` of `@kyro/shared` without its command typing (the `ada_*` entries are not there yet). */
const raw = call as unknown as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
const ada = <T>(cmd: string, args?: Record<string, unknown>) => raw(cmd, args) as Promise<T>;

/** The `ada_*` commands (docs/IPC.md §2.7). */
export function rustCardanoBackend(): CardanoBackend {
  return {
    address: (index) => ada('ada_address', { index }),
    account: (address) => ada('ada_account', { address }),
    txs: (address) => ada('ada_txs', { address }),
    build: (to, lovelace, token, memo) =>
      ada('ada_build_tx', { to, ...(lovelace !== undefined ? { lovelace } : {}), ...(token ? { token } : {}), ...(memo ? { memo } : {}) }),
    sign: (tx, password) => ada('ada_sign_tx', { tx, password }),
    broadcast: (tx) => ada('ada_broadcast', { tx }),
    txStatus: (hash) => ada('ada_tx_status', { hash }),
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

/** Byron (bootstrap) addresses: refused by Kyro, the UI says why. */
export function isByronAddress(address: string): boolean {
  const a = address.trim();
  return /^(Ae2|DdzFF|37btjrVyb4K)[1-9A-HJ-NP-Za-km-z]+$/.test(a);
}

/** "1,5" / "1.5" ADA → lovelace (6 decimals), exact. */
export function adaToLovelace(input: string): bigint {
  const s = input.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error('Montant ADA invalide (6 décimales max.)');
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
}

export class CardanoAdapter {
  readonly family = 'ada' as const;
  readonly chain: CardanoChain;
  private readonly address: string;
  private readonly backend: CardanoBackend;

  constructor(opts: CardanoAdapterOptions) {
    if (!isCardanoAddress(opts.address, opts.chain.network)) throw new Error('Adresse Cardano invalide');
    this.chain = opts.chain;
    this.address = opts.address;
    this.backend = opts.backend ?? rustCardanoBackend();
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

  /** ADA balance (`spendable` = balance − ADA tied to the tokens) and native tokens. */
  async getBalance(): Promise<{ ada: { amount: bigint; spendable: bigint }; tokens: CardanoTokenBalance[] }> {
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
    if (isByronAddress(to)) throw new Error('Adresse Byron refusée : demande une adresse Shelley (addr1…)');
    if (!isCardanoAddress(to, this.chain.network)) throw new Error('Adresse Cardano invalide');
    if (params.lovelace === undefined && !params.token) throw new Error('Montant ADA manquant');
    if (params.lovelace !== undefined && params.lovelace <= 0n) throw new Error('Montant ADA invalide');
    if (params.memo !== undefined && new TextEncoder().encode(params.memo).length > 1024) throw new Error('Message trop long (1 024 octets max.)');
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
      throw new Error('La transaction construite par Rust ne correspond pas à la demande');
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
    };
  }

  /** Rust: live checks, native dialog (each output, tokens, min-ADA, fee, ttl), signature. */
  async signTx(unsigned: CardanoUnsigned, password: string): Promise<CardanoSigned> {
    const res = await this.backend.sign(unsigned.tx, password);
    if (!/^[0-9a-f]{64}$/.test(res.txId) || res.txId !== unsigned.summary.txId) throw new Error('Identifiant de transaction Cardano inattendu');
    return { family: 'ada', tx: res.tx, txId: res.txId, summary: res.summary };
  }

  /** Rust verifies the witness and that Koios answers our tx id. */
  async broadcast(signed: CardanoSigned): Promise<string> {
    const id = await this.backend.broadcast(signed.tx);
    if (id !== signed.txId) throw new Error('Identifiant diffusé inattendu');
    return id;
  }

  txStatus(hash: string): Promise<{ confirmations: number | null }> {
    return this.backend.txStatus(hash);
  }

  async getHistory(): Promise<Array<{ id: string; direction: 'in' | 'out'; amount: bigint; fee?: bigint; time?: number; memo?: string; tokenDeltas: CardanoHistoryEntry['tokenDeltas'] }>> {
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
