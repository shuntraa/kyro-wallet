// SPDX-License-Identifier: GPL-3.0-or-later
//
// Hedera adapter (HBAR). Thin on purpose: reads (mirror node), CryptoTransfer building (one copy
// per consensus node, max fee from the exchange rate), signature and submission are Rust commands
// (`hbar_*`, docs/IPC.md §2.11). This adapter only validates input and checks that what Rust built
// is what was asked (recipient, amount, **memo**).
//
// The adapter's address is the EVM address of the ECDSA key: the first HBAR sent to it creates the
// account `0.0.x` (HIP-583 auto-creation); `account()` reads that ID from the mirror node.

import { accountArg } from '../types';
import {
  call,
  l10n,
  type HbarAccountInfo,
  type HbarBuilt,
  type HbarContext,
  type HbarHistoryEntry,
  type HbarOwnAccount,
  type HbarRecipientInfo,
  type HbarTokenHolding,
  type HbarTxSummary,
  type HbarWarning,
} from '@kyro/shared';
import { HBAR_TOKENS, type HbarChain } from '../registry';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem } from '../types';

export type { HbarAccountInfo, HbarContext, HbarHistoryEntry, HbarOwnAccount, HbarRecipientInfo, HbarTokenHolding, HbarTxSummary, HbarWarning };

export interface HbarBackend {
  account(): Promise<HbarOwnAccount>;
  recipient(to: string): Promise<HbarRecipientInfo>;
  txs(accountId: string): Promise<HbarHistoryEntry[]>;
  build(to: string, amount: string, memo?: string): Promise<HbarBuilt>;
  sign(bodies: string[], password: string): Promise<{ signed: string[]; summary: HbarTxSummary; context: HbarContext }>;
  broadcast(signed: string[]): Promise<string>;
  txStatus(id: string): Promise<{ found: boolean; result: string }>;
  /** Known HTS tokens; optional so that test backends can leave them out. */
  tokenHoldings?(accountId: string): Promise<HbarTokenHolding[]>;
  buildAssociate?(tokenId: string): Promise<HbarBuilt>;
  buildToken?(tokenId: string, to: string, amount: string, memo?: string): Promise<HbarBuilt>;
}

/** The typed `hbar_*` commands of `@kyro/shared` (docs/IPC.md §2.11), for vault account `account`. */
export function rustHbarBackend(account = 0): HbarBackend {
  const acct = accountArg(account);
  return {
    account: () => call('hbar_account', { ...acct }),
    recipient: (to) => call('hbar_recipient', { to }),
    txs: (accountId) => call('hbar_txs', { accountId }),
    build: (to, amount, memo) => call('hbar_build_tx', { to, amount, ...(memo ? { memo } : {}), ...acct }),
    sign: (bodies, password) => call('hbar_sign_tx', { bodies, password, ...acct }),
    broadcast: (signed) => call('hbar_broadcast', { signed, ...acct }),
    txStatus: (id) => call('hbar_tx_status', { id }),
    tokenHoldings: (accountId) => call('hbar_token_holdings', { accountId }),
    buildAssociate: (tokenId) => call('hbar_build_associate_tx', { tokenId, ...acct }),
    buildToken: (tokenId, to, amount, memo) => call('hbar_build_token_tx', { tokenId, to, amount, ...(memo ? { memo } : {}), ...acct }),
  };
}

// ---------------------------------------------------------------- recipients and memos

/** `0.0.x` (HIP-15 checksum `-abcde` optional; verified by Rust for the network). */
export function isHbarAccountId(input: string): boolean {
  return /^0\.0\.[1-9]\d{0,18}(-[a-z]{5})?$/.test(input.trim());
}

/** `0x` + 40 hex (EIP-55 checksum verified by Rust). */
export function isHbarEvmAddress(input: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(input.trim());
}

/** A Hedera recipient: account ID or EVM address. */
export function isHbarRecipient(input: string): boolean {
  return isHbarAccountId(input) || isHbarEvmAddress(input);
}

/**
 * The recipient as Rust will sign it, for comparison: `0.0.x` without checksum, long-zero EVM
 * addresses turned into `0.0.x`, other EVM addresses lowercase.
 */
export function normalizeHbarRecipient(input: string): string {
  const t = input.trim();
  if (isHbarEvmAddress(t)) {
    const hex = t.slice(2).toLowerCase();
    if (/^0{24}/.test(hex)) return `0.0.${BigInt(`0x${hex.slice(24)}`).toString()}`;
    return `0x${hex}`;
  }
  return t.split('-')[0] ?? t;
}

const MEMO_BYTES = 100;
// eslint-disable-next-line no-control-regex
const MEMO_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/;

/** Rust's rule (`hbar_check_memo`): ≤ 100 bytes UTF-8, no control / invisible / bidi character. `null` = valid. */
export function hbarMemoError(memo: string): string | null {
  if (new TextEncoder().encode(memo).length > MEMO_BYTES) return l10n('Mémo trop long : 100 octets au plus.', 'Memo too long: 100 bytes at most.');
  if (MEMO_FORBIDDEN.test(memo)) return l10n('Mémo : caractères de contrôle, invisibles ou de direction refusés.', 'Memo: control, invisible or direction characters refused.');
  return null;
}

// ---------------------------------------------------------------- adapter

export interface HbarUnsigned {
  family: 'hbar';
  /** One unsigned body per consensus node (hex). */
  bodies: string[];
  summary: HbarTxSummary;
  context: HbarContext;
  recipient: string;
  /** Tinybars (token: its units). */
  amount: bigint;
  memo?: string;
  /** Maximum fee set by Rust (tinybars); only the actual fee (≈ $0.0001) is charged. */
  maxFee: bigint;
  size: { family: 'hbar' };
}

export interface HbarSigned {
  family: 'hbar';
  signed: string[];
  summary: HbarTxSummary;
}

export interface HbarAdapterOptions {
  chain: HbarChain;
  /** Our EVM address (EIP-55), from `accounts_get`. */
  address: string;
  backend?: HbarBackend;
  /** Vault account (docs/IPC.md §2.9) passed to every command; absent = 0. */
  account?: number;
}

export class HbarAdapter implements ChainAdapter<'hbar'> {
  readonly family = 'hbar' as const;
  readonly chain: HbarChain;
  private readonly address: string;
  private readonly backend: HbarBackend;

  constructor(opts: HbarAdapterOptions) {
    if (!isHbarEvmAddress(opts.address)) throw new Error(l10n('Adresse EVM Hedera invalide', 'Invalid Hedera EVM address'));
    this.chain = opts.chain;
    this.address = opts.address;
    this.backend = opts.backend ?? rustHbarBackend(opts.account ?? 0);
  }

  /** The EVM address of our key (receiving there auto-creates the account). */
  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return isHbarRecipient(address);
  }

  /** Our account on the mirror node (`exists: false` until the first HBAR received). */
  account(): Promise<HbarOwnAccount> {
    return this.backend.account();
  }

  /** Recipient facts the Send screen needs before building: exists? deleted? signature required? */
  recipientInfo(to: string): Promise<HbarRecipientInfo> {
    return this.backend.recipient(to);
  }

  async getBalance(): Promise<Balance[]> {
    const acc = await this.backend.account();
    const out: Balance[] = [{ assetId: 'hbar', amount: BigInt(acc.balance) }];
    if (acc.exists && acc.accountId) {
      for (const h of await this.tokenHoldings(acc.accountId)) {
        if (h.associated && /^\d+$/.test(h.balance)) out.push({ assetId: `hts:${h.tokenId}`, amount: BigInt(h.balance) });
      }
    }
    return out;
  }

  /** Known HTS tokens of the network (USDC). */
  knownTokens() {
    return HBAR_TOKENS[this.chain.network];
  }

  /** Holdings of the known tokens for `0.0.x` (rows for other tokens are dropped). */
  async tokenHoldings(accountId: string): Promise<HbarTokenHolding[]> {
    if (!this.backend.tokenHoldings || !this.knownTokens().length) return [];
    const known = new Set(this.knownTokens().map((t) => t.contract));
    return (await this.backend.tokenHoldings(accountId)).filter((h) => known.has(h.tokenId));
  }

  /** `TokenAssociate` of a known token for our account. Signed with `signTx`. */
  async buildAssociate(tokenId: string): Promise<HbarUnsigned> {
    const k = this.knownTokens().find((t) => t.contract === tokenId);
    if (!k || !this.backend.buildAssociate) throw new Error(l10n('Jeton Hedera inconnu', 'Unknown Hedera token'));
    const built = await this.backend.buildAssociate(tokenId);
    const s = built.summary;
    const t = s.token;
    if (!t || !t.associate || t.tokenId !== tokenId || t.decimals !== k.decimals || s.amount !== '0' || s.to !== s.from || s.from !== built.context.account.accountId || s.memo !== null || built.bodies.length !== s.nodes.length) {
      throw new Error(l10n('L’association construite par Rust ne correspond pas à la demande', 'The association built by Rust does not match the request'));
    }
    return { family: 'hbar', bodies: built.bodies, summary: s, context: built.context, recipient: s.from, amount: 0n, maxFee: BigInt(s.maxFee), size: { family: 'hbar' } };
  }

  /** Token transfer (units); Rust re-checks both holdings (associated, frozen) and the HBAR for the fee. */
  private async buildTokenTx(params: BuildParams): Promise<HbarUnsigned> {
    const k = this.knownTokens().find((t) => `hts:${t.contract}` === params.asset.id);
    if (!k || k.decimals !== params.asset.decimals || !this.backend.buildToken) throw new Error(l10n('Jeton Hedera inconnu', 'Unknown Hedera token'));
    const to = params.to.trim();
    if (!isHbarRecipient(to)) throw new Error(l10n('Destinataire Hedera invalide (0.0.x ou adresse EVM 0x…)', 'Invalid Hedera recipient (0.0.x or EVM address 0x…)'));
    if (normalizeHbarRecipient(to) === this.address.toLowerCase()) throw new Error(l10n('Transfert à soi-même impossible', 'Transfer to yourself not possible'));
    let amount = params.amount;
    if (params.max === true) {
      const acc = await this.backend.account();
      const h = acc.accountId ? (await this.tokenHoldings(acc.accountId)).find((x) => x.tokenId === k.contract) : undefined;
      amount = h ? BigInt(h.balance) : 0n;
    }
    if (amount <= 0n) throw new Error(l10n('Montant invalide', 'Invalid amount'));
    const memo = params.memo ?? '';
    const memoErr = hbarMemoError(memo);
    if (memoErr) throw new Error(memoErr);
    const built = await this.backend.buildToken(k.contract, to, amount.toString(), memo || undefined);
    const s = built.summary;
    const t = s.token;
    if (!t || t.associate || t.tokenId !== k.contract || t.decimals !== k.decimals || normalizeHbarRecipient(s.to) !== normalizeHbarRecipient(to) || s.amount !== amount.toString() || (s.memo ?? '') !== memo || s.from !== built.context.account.accountId || built.bodies.length !== s.nodes.length || s.warnings.some((w) => w.kind === 'unusualText')) {
      throw new Error(l10n('Le transfert construit par Rust ne correspond pas à la demande', 'The transfer built by Rust does not match the request'));
    }
    return { family: 'hbar', bodies: built.bodies, summary: s, context: built.context, recipient: to, amount, ...(memo ? { memo } : {}), maxFee: BigInt(s.maxFee), size: { family: 'hbar' } };
  }

  /** No fee to choose: Rust sets a max fee from the exchange rate; ≈ $0.0001 is charged. */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'hbar' as const };
    const eta = this.chain.blockTimeSecs;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: l10n('frais fixés par le réseau (≈ 0,0001 $)', 'fee set by the network (≈ $0.0001)'),
      fetchedAt: Date.now(),
    });
  }

  /** `ChainAdapter` entry point. `max`: balance minus the max fee Rust sets (built twice). */
  async buildTx(params: BuildParams): Promise<HbarUnsigned> {
    if (params.asset.kind === 'hts') return this.buildTokenTx(params);
    if (params.asset.kind !== 'native') throw new Error(l10n('Actif Hedera inattendu', 'Unexpected Hedera asset'));
    const memo = params.memo !== undefined && params.memo !== '' ? { memo: params.memo } : {};
    if (!params.max) return this.buildTransfer({ to: params.to, amount: params.amount, ...memo });
    const balance = BigInt((await this.backend.account()).balance);
    const first = await this.buildTransfer({ to: params.to, amount: 1n, ...memo });
    const amount = balance - first.maxFee;
    if (amount <= 0n) throw new Error(l10n('Rien à envoyer : ton solde ne couvre pas les frais maximum', 'Nothing to send: your balance does not cover the maximum fee'));
    return this.buildTransfer({ to: params.to, amount, ...memo });
  }

  /** `amount`: tinybars. Rust re-checks the recipient, the balance and the memo. */
  async buildTransfer(params: { to: string; amount: bigint; memo?: string }): Promise<HbarUnsigned> {
    const to = params.to.trim();
    if (!isHbarRecipient(to)) throw new Error(l10n('Destinataire Hedera invalide (0.0.x ou adresse EVM 0x…)', 'Invalid Hedera recipient (0.0.x or EVM address 0x…)'));
    if (normalizeHbarRecipient(to) === this.address.toLowerCase()) throw new Error(l10n('Transfert à soi-même impossible', 'Transfer to yourself not possible'));
    if (params.amount <= 0n) throw new Error(l10n('Montant invalide', 'Invalid amount'));
    const memo = params.memo ?? '';
    const memoErr = hbarMemoError(memo);
    if (memoErr) throw new Error(memoErr);
    const built = await this.backend.build(to, params.amount.toString(), memo || undefined);
    const s = built.summary;
    const unusual = s.warnings.some((w) => w.kind === 'unusualText');
    if (
      normalizeHbarRecipient(s.to) !== normalizeHbarRecipient(to) ||
      s.amount !== params.amount.toString() ||
      (s.memo ?? '') !== memo ||
      s.from !== built.context.account.accountId ||
      built.bodies.length !== s.nodes.length ||
      unusual
    ) {
      throw new Error(l10n('Le transfert construit par Rust ne correspond pas à la demande', 'The transfer built by Rust does not match the request'));
    }
    return {
      family: 'hbar',
      bodies: built.bodies,
      summary: s,
      context: built.context,
      recipient: to,
      amount: params.amount,
      ...(memo ? { memo } : {}),
      maxFee: BigInt(s.maxFee),
      size: { family: 'hbar' },
    };
  }

  /** Rust: live checks, native dialog (memo framed), signature of every copy. */
  async signTx(unsigned: HbarUnsigned, password: string): Promise<HbarSigned> {
    const res = await this.backend.sign(unsigned.bodies, password);
    if (res.summary.transactionId !== unsigned.summary.transactionId || res.signed.length !== unsigned.bodies.length) throw new Error(l10n('Signature Hedera inattendue', 'Unexpected Hedera signature'));
    return { family: 'hbar', signed: res.signed, summary: res.summary };
  }

  /** Rust re-verifies the signatures, then submits node after node. Returns the transaction ID. */
  async broadcast(signed: HbarSigned): Promise<string> {
    const id = await this.backend.broadcast(signed.signed);
    if (id !== signed.summary.transactionId) throw new Error(l10n('Identifiant de transaction inattendu', 'Unexpected transaction ID'));
    return id;
  }

  txStatus(id: string): Promise<{ found: boolean; result: string }> {
    return this.backend.txStatus(id);
  }

  async getHistory(): Promise<HistoryItem[]> {
    const acc = await this.backend.account();
    if (!acc.exists || !acc.accountId) return [];
    const me = acc.accountId;
    const list = await this.backend.txs(me);
    const known = this.knownTokens();
    const tokenItems = list.flatMap((t): HistoryItem[] =>
      (t.tokenTransfers ?? []).flatMap((x, i): HistoryItem[] => {
        const k = known.find((y) => y.contract === x.tokenId);
        if (!k || !/^-?\d+$/.test(x.delta) || x.delta === '0') return [];
        const d = BigInt(x.delta);
        const item: HistoryItem = { id: `${t.id}:hts:${i}`, chainKey: this.chain.key, assetId: `hts:${k.contract}`, direction: d < 0n ? 'out' : 'in', amount: d < 0n ? -d : d, status: t.result === 'SUCCESS' ? 'confirmed' : 'failed', kind: 'transfer' };
        if (t.time) item.time = t.time;
        if (t.counterparty) item.counterparty = t.counterparty;
        return [item];
      }),
    );
    const native = list.map((t) => {
      const payer = t.id.split('-')[0] ?? '';
      const item: HistoryItem = {
        id: t.id,
        chainKey: this.chain.key,
        assetId: 'hbar',
        direction: t.outgoing ? 'out' : 'in',
        amount: BigInt(t.amount),
        status: t.result === 'SUCCESS' ? 'confirmed' : 'failed',
        kind: t.name === 'CRYPTOTRANSFER' ? 'transfer' : 'contract',
      };
      if (t.outgoing && BigInt(t.fee) > 0n) item.fee = BigInt(t.fee);
      if (t.counterparty) item.counterparty = t.counterparty;
      if (t.time) item.time = t.time;
      if (t.memo) item.note = l10n(`Mémo : « ${t.memo} »`, `Memo: “${t.memo}”`);
      if (t.name === 'TOKENASSOCIATE') item.note = l10n('Association d’un jeton (activation de la réception)', 'Token association (enables receiving it)');
      else if (BigInt(t.amount) === 0n && !(t.tokenTransfers ?? []).length) item.suspect = 'zero';
      else if (t.outgoing && payer !== me) item.suspect = 'notSigned';
      return item;
    });
    // A token transfer also has an HBAR row (its fee): keep it, with the token row next to it.
    return tokenItems.length ? [...tokenItems, ...native].sort((a, b) => (b.time ?? 0) - (a.time ?? 0)) : native;
  }
}
