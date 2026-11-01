// SPDX-License-Identifier: GPL-3.0-or-later
// Sui adapter (SUI). Thin on purpose: reads, transfer building (gas coins, reference gas price, budget from a simulation, BCS encoded by wallet-core), signature and execution are Rust commands (`sui_*`, docs/IPC.md §2.11).

import { call, l10n, type SuiBalance, type SuiBuilt, type SuiContext, type SuiHistoryEntry, type SuiTokenBalance, type SuiTxStatus, type SuiTxSummary, type SuiWarning } from '@kyro/shared';
import { SUI_COINS, type SuiChain } from '../registry';
import type { HwSigner } from '../hw';
import { accountArg, type Balance, type BuildParams, type ChainAdapter, type FeeEstimates, type HistoryItem } from '../types';

export type { SuiBalance, SuiContext, SuiHistoryEntry, SuiTokenBalance, SuiTxStatus, SuiTxSummary, SuiWarning };

export interface SuiBackend {
  balance(address: string): Promise<SuiBalance>;
  txs(address: string): Promise<SuiHistoryEntry[]>;
  /** `amount` MIST; null = the whole balance. */
  build(to: string, amount: bigint | null): Promise<SuiBuilt>;
  /** `coinType`: token transfer (Rust re-checks the token coins live). */
  sign(bcs: string, password: string, coinType?: string): Promise<SuiBuilt & { signature: string; digest: string }>;
  broadcast(bcs: string, signature: string): Promise<string>;
  txStatus(digest: string): Promise<SuiTxStatus>;
  /** Known tokens (Circle's USDC); optional so that test backends can leave them out. */
  tokenBalances?(address: string): Promise<SuiTokenBalance[]>;
  /** Token units; null = the whole balance of that token. */
  buildToken?(coinType: string, to: string, amount: bigint | null): Promise<SuiBuilt>;
}

/** The typed `sui_*` commands of `@kyro/shared` (docs/IPC.md §2.11), for vault account `account`. */
export function rustSuiBackend(account = 0): SuiBackend {
  const acct = accountArg(account);
  return {
    balance: (address) => call('sui_balance', { address }),
    txs: (address) => call('sui_txs', { address }),
    build: (to, amount) => call('sui_build_tx', amount === null ? { to, all: true, ...acct } : { to, amount: amount.toString(), ...acct }),
    sign: (bcs, password, coinType) => call('sui_sign_tx', { bcs, password, ...(coinType ? { coinType } : {}), ...acct }),
    broadcast: (bcs, signature) => call('sui_broadcast', { bcs, signature, ...acct }),
    txStatus: (digest) => call('sui_tx_status', { digest }),
    tokenBalances: (address) => call('sui_token_balances', { address }),
    buildToken: (coinType, to, amount) => call('sui_build_token_tx', amount === null ? { coinType, to, all: true, ...acct } : { coinType, to, amount: amount.toString(), ...acct }),
  };
}

/** Ledger account `accountId` (docs/IPC.md §2.3): build and broadcast for its address, signature on the device (`hw_*` commands). */
export function rustSuiHwBackend(accountId: string): SuiBackend {
  // Token sends are vault-only for now (Rust's hw_* builders only do the native coin).
  const { buildToken: _buildTokenVaultOnly, ...base } = rustSuiBackend();
  return {
    ...base,
    build: (to, amount) => call('hw_sui_build_tx', amount === null ? { accountId, to, all: true } : { accountId, to, amount: amount.toString() }),
    sign: (bcs, id) => call('hw_sign_sui_tx', { id, accountId, bcs }),
    broadcast: (bcs, signature) => call('hw_sui_broadcast', { accountId, bcs, signature }),
  };
}

export const SUI_COIN_TYPE = '0x2::sui::SUI';

/** Full Sui address: `0x` + exactly 64 hex characters (no checksum exists on Sui). */
export function isSuiAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(address.trim());
}

/** Why an input is not a full Sui address (null when it is). Same rules as wallet-core. */
export function suiAddressProblem(address: string): string | null {
  const a = address.trim();
  if (a === '') return null;
  if (a.endsWith('.sui') || a.startsWith('@')) return l10n('Les noms SuiNS ne sont pas pris en charge : colle l’adresse 0x… complète.', 'SuiNS names are not supported: paste the full 0x… address.');
  if (!a.startsWith('0x')) return l10n('Adresse Sui : 0x suivi de 64 caractères hexadécimaux.', 'Sui address: 0x followed by 64 hexadecimal characters.');
  if (/^0x[0-9a-fA-F]{1,63}$/.test(a)) return l10n('Forme courte refusée : il faut les 64 caractères après 0x.', 'Short form refused: all 64 characters after 0x are needed.');
  if (!isSuiAddress(a)) return l10n('Adresse Sui invalide (0x + 64 caractères hexadécimaux).', 'Invalid Sui address (0x + 64 hexadecimal characters).');
  return null;
}

/** `0x` + lowercase hex: how Rust prints addresses. */
export function normalizeSuiAddress(address: string): string {
  return address.trim().toLowerCase();
}

export interface SuiUnsigned {
  family: 'sui';
  /** BCS base64, what Rust signs (it decodes it again before the dialog). */
  bcs: string;
  summary: SuiTxSummary;
  context: SuiContext;
  recipient: string;
  /** MIST asked; for « tout le solde », what the simulation says the recipient receives. */
  amount: bigint;
  all: boolean;
  /** Gas budget (MIST): the most the transfer can cost on top of the amount (always SUI). */
  maxFee: bigint;
  size: { family: 'sui' };
  /** Token transfer: its coin type (passed again to `sui_sign_tx`); `amount` is then in token units. */
  coinType?: string;
}

export interface SuiSigned {
  family: 'sui';
  bcs: string;
  signature: string;
  digest: string;
  summary: SuiTxSummary;
}

export interface SuiAdapterOptions {
  chain: SuiChain;
  address: string;
  backend?: SuiBackend;
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
  /** Hardware-wallet account (Ledger): signing through `hw_sign_*` (`signTxHw`). */
  hw?: HwSigner;
}

export class SuiAdapter implements ChainAdapter<'sui'> {
  readonly family = 'sui' as const;
  readonly chain: SuiChain;
  private readonly address: string;
  readonly hw: HwSigner | null;
  private readonly backend: SuiBackend;

  constructor(opts: SuiAdapterOptions) {
    if (!isSuiAddress(opts.address)) throw new Error(l10n('Adresse Sui invalide', 'Invalid Sui address'));
    this.chain = opts.chain;
    this.address = normalizeSuiAddress(opts.address);
    this.hw = opts.hw ?? null;
    this.backend = opts.backend ?? (opts.hw ? rustSuiHwBackend(opts.hw.accountId) : rustSuiBackend(opts.account ?? 0));
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    return isSuiAddress(address);
  }

  balanceInfo(): Promise<SuiBalance> {
    return this.backend.balance(this.address);
  }

  /** Total SUI, plus `spendable` = what sits in coin objects (the address balance is not spent by Kyro). Known tokens too. */
  async getBalance(): Promise<Array<Balance & { spendable: bigint }>> {
    const b = await this.backend.balance(this.address);
    const out = [{ assetId: 'sui', amount: BigInt(b.total), spendable: BigInt(b.coin) }];
    const known = SUI_COINS[this.chain.network];
    if (known.length && this.backend.tokenBalances) {
      for (const t of await this.backend.tokenBalances(this.address)) {
        const k = known.find((x) => x.contract === t.coinType);
        if (k && /^\d+$/.test(t.total) && /^\d+$/.test(t.coin)) out.push({ assetId: `suicoin:${k.contract}`, amount: BigInt(t.total), spendable: BigInt(t.coin) });
      }
    }
    return out;
  }

  /** Token transfer: Rust picks and merges the token coins, pays the gas in SUI, simulates. */
  private async buildToken(params: BuildParams, to: string): Promise<SuiUnsigned> {
    if (this.hw) throw new Error(l10n('Jetons Sui : pas encore pris en charge sur hardware wallet', 'Sui tokens: not yet supported on hardware wallets'));
    const k = SUI_COINS[this.chain.network].find((x) => x.contract === params.asset.contract);
    if (!k || k.decimals !== params.asset.decimals || !this.backend.buildToken) throw new Error(l10n('Jeton Sui inconnu', 'Unknown Sui token'));
    const all = !!params.max;
    if (!all && params.amount <= 0n) throw new Error(l10n('Montant invalide', 'Invalid amount'));
    const built = await this.backend.buildToken(k.contract, to, all ? null : params.amount);
    const s = built.summary;
    const tk = s.token;
    const amountOk = all ? s.amount === null : s.amount === params.amount.toString();
    const warningsOk = s.warnings.every((w) => (all && w.kind === 'sendAll') || (to === this.address && w.kind === 'selfTransfer'));
    if (!tk || tk.coinType !== k.contract || tk.decimals !== k.decimals || s.coinType !== k.contract || !amountOk || !warningsOk || s.recipient !== to || s.sender !== this.address) {
      throw new Error(l10n('Le transfert construit par Rust ne correspond pas à la demande', 'The transfer built by Rust does not match the request'));
    }
    return {
      family: 'sui',
      bcs: built.bcs,
      summary: s,
      context: built.context,
      recipient: to,
      amount: all ? BigInt(built.context.receives ?? built.context.token?.coinsTotal ?? '0') : params.amount,
      all,
      maxFee: BigInt(s.gasBudget),
      size: { family: 'sui' },
      coinType: k.contract,
    };
  }

  /** No fee to choose: Rust uses the reference gas price and a budget from a simulation. */
  estimateFees(): Promise<FeeEstimates> {
    const p = { family: 'sui' as const };
    const eta = this.chain.blockTimeSecs;
    return Promise.resolve({
      options: { slow: { level: 'slow', params: p, etaSecs: eta }, normal: { level: 'normal', params: p, etaSecs: eta }, fast: { level: 'fast', params: p, etaSecs: eta } },
      minimum: p,
      hint: l10n('frais fixés par le réseau (prix du gaz de référence, ≈ 0,002 SUI)', 'fee set by the network (reference gas price, ≈ 0.002 SUI)'),
      fetchedAt: Date.now(),
    });
  }

  async buildTx(params: BuildParams): Promise<SuiUnsigned> {
    if (params.asset.kind !== 'native' && params.asset.kind !== 'suicoin') throw new Error(l10n('Actif Sui inattendu', 'Unexpected Sui asset'));
    const problem = suiAddressProblem(params.to);
    if (problem) throw new Error(problem);
    const to = normalizeSuiAddress(params.to);
    if (!isSuiAddress(to)) throw new Error(l10n('Adresse Sui invalide', 'Invalid Sui address'));
    if (params.asset.kind === 'suicoin') return this.buildToken(params, to);
    const all = !!params.max;
    if (!all && params.amount <= 0n) throw new Error(l10n('Montant invalide', 'Invalid amount'));
    const built = await this.backend.build(to, all ? null : params.amount);
    const s = built.summary;
    const amountOk = all ? s.amount === null : s.amount === params.amount.toString();
    const warningsOk = s.warnings.every((w) => (all && w.kind === 'sendAll') || (to === this.address && w.kind === 'selfTransfer'));
    if (!amountOk || !warningsOk || s.recipient !== to || s.sender !== this.address || s.coinType !== SUI_COIN_TYPE || s.token) {
      throw new Error(l10n('Le transfert construit par Rust ne correspond pas à la demande', 'The transfer built by Rust does not match the request'));
    }
    return {
      family: 'sui',
      bcs: built.bcs,
      summary: s,
      context: built.context,
      recipient: to,
      amount: all ? BigInt(built.context.receives ?? '0') : params.amount,
      all,
      maxFee: BigInt(s.gasBudget),
      size: { family: 'sui' },
    };
  }

  /** Ledger: same checks as `signTx`; Rust re-reads the key, shows its dialog, then the device signs. */
  signTxHw(unsigned: SuiUnsigned, deviceId: string): Promise<SuiSigned> {
    if (!this.hw) return Promise.reject(new Error(l10n('Ce compte n’est pas un hardware wallet', 'This account is not a hardware wallet')));
    return this.signTx(unsigned, deviceId);
  }

  /** Rust: live checks, simulation, native dialog, signature. */
  async signTx(unsigned: SuiUnsigned, password: string): Promise<SuiSigned> {
    const res = await this.backend.sign(unsigned.bcs, password, unsigned.coinType);
    if (res.digest !== unsigned.summary.digest || res.bcs !== unsigned.bcs) throw new Error(l10n('Transaction Sui signée inattendue', 'Unexpected signed Sui transaction'));
    return { family: 'sui', bcs: res.bcs, signature: res.signature, digest: res.digest, summary: res.summary };
  }

  /** Rust verifies the signature and that the executed digest is ours. */
  async broadcast(signed: SuiSigned): Promise<string> {
    const digest = await this.backend.broadcast(signed.bcs, signed.signature);
    if (digest !== signed.digest) throw new Error(l10n('Empreinte diffusée inattendue', 'Unexpected broadcast digest'));
    return digest;
  }

  txStatus(digest: string): Promise<SuiTxStatus> {
    return this.backend.txStatus(digest);
  }

  async getHistory(): Promise<HistoryItem[]> {
    const list = await this.backend.txs(this.address);
    const known = SUI_COINS[this.chain.network];
    return list.flatMap((t) => {
      const tokens = (t.tokens ?? []).flatMap((x): HistoryItem[] => {
        const k = known.find((y) => y.contract === x.coinType);
        if (!k || !/^-?\d+$/.test(x.change)) return [];
        const ch = BigInt(x.change);
        const item: HistoryItem = { id: `${t.digest}:${k.contract}`, chainKey: this.chain.key, assetId: `suicoin:${k.contract}`, direction: ch < 0n ? 'out' : 'in', amount: ch < 0n ? -ch : ch, status: t.success ? 'confirmed' : 'failed', kind: 'transfer' };
        const cp = x.counterparty ?? (t.sender !== this.address ? t.sender : null);
        if (cp) item.counterparty = cp;
        if (t.timestamp) {
          const ms = Date.parse(t.timestamp);
          if (Number.isFinite(ms)) item.time = ms;
        }
        return [item];
      });
      const native = suiHistoryItem(t, this.address, this.chain.key);
      // A token transfer we sent: its SUI row is only the gas (shown on the token row).
      return tokens.length && native.amount === 0n ? tokens : [...tokens, native];
    });
  }
}

/** One `sui_txs` entry as a history row: the net SUI change of `me`, fees separated when we sent it. */
export function suiHistoryItem(t: SuiHistoryEntry, me: string, chainKey = 'sui'): HistoryItem {
  const change = BigInt(t.change);
  const fee = t.fee !== null ? BigInt(t.fee) : 0n;
  const sent = t.sender === me;
  // Outgoing: what left besides the gas. Incoming: what arrived.
  const amount = sent ? -change - fee : change;
  const direction = sent ? (amount > 0n ? 'out' : 'self') : 'in';
  const item: HistoryItem = {
    id: t.digest,
    chainKey,
    assetId: 'sui',
    direction,
    amount: amount < 0n ? -amount : amount,
    status: t.success ? 'confirmed' : 'failed',
    kind: 'transfer',
  };
  if (sent && t.fee !== null) item.fee = fee;
  const counterparty = sent ? t.counterparty : (t.counterparty ?? t.sender);
  if (counterparty) item.counterparty = counterparty;
  if (t.timestamp) {
    const ms = Date.parse(t.timestamp);
    if (Number.isFinite(ms)) item.time = ms;
  }
  if (t.otherCoins) item.note = l10n('D’autres jetons ont bougé dans cette transaction (non détaillés)', 'Other tokens moved in this transaction (not detailed)');
  if (!sent && amount <= 0n) item.suspect = 'zero';
  return item;
}
