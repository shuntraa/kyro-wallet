// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — XRP Ledger (`xrp_*`, docs/IPC.md §2.6), mirroring apps/desktop/src-tauri/src/
// commands_xrp.rs and xrp_backend.rs. The address is really derived (m/44'/144'/0'/0/0, Ripple
// base58check of RIPEMD160(SHA256(pubkey))); the Payment blob is a demo encoding (hex JSON, NOT
// the canonical binary format wallet-core writes) and the signature is fake. The rules are Rust's:
// - reserve = 1 XRP base + 0.2 XRP per owned object; spendable = balance − reserve;
// - destination with lsfRequireDestTag and no tag → refused; unfunded destination → ≥ 1 XRP
//   (tecNO_DST_INSUF_XRP); issued currency to an unfunded account → refused (tecNO_DST);
//   amount + fee > spendable → refused; our account not activated → refused;
// - decoding refuses X-addresses, Paths, DeliverMin and partial payments (tfPartialPayment);
// - sign re-reads everything live, refuses an expired LastLedgerSequence or a stale Sequence;
// - a submitted payment is validated a few seconds later (`xrp_tx_status`).
//
// Scenario words in a custom rippled URL: « down » → SERVER_UNREACHABLE, « wrong » →
// SERVER_WRONG_NETWORK.

import { HDKey } from '@scure/bip32';
import * as bitcoin from 'bitcoinjs-lib';
import { base58xrp } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  IpcError,
  type Commands,
  type Network,
  type ServerTestResult,
  type Settings,
  type XrpAccountInfo,
  type XrpAmountView,
  type XrpBackendInfo,
  type XrpContext,
  type XrpHistoryEntry,
  type XrpServer,
  type XrpTrustLine,
  type XrpTxSummary,
  type XrpWarning,
} from './ipc';
import { checkServerUrl } from './servers';
import type { DemoTor } from './mock-tor';
import { l10n } from './i18n';

export const XRP_RESERVE_BASE = 1_000_000n;
export const XRP_RESERVE_INC = 200_000n;
const FEE = 12n;
/** Rust: LastLedgerSequence = current + 20 (≈ 1 min). */
const LLS_OFFSET = 20;
const TF_FULLY_CANONICAL_SIG = 0x80000000;
const TF_PARTIAL_PAYMENT = 0x00020000;
/** Demo: a submitted payment is in a validated ledger after this long. */
const VALIDATION_MS = 4_000;

/** Classic `r…` address of a 20-byte account ID (Ripple base58check, version 0). */
export function xrpAddressOfId(id: Uint8Array): string {
  const payload = new Uint8Array([0, ...id]);
  const sum = sha256(sha256(payload)).slice(0, 4);
  return base58xrp.encode(new Uint8Array([...payload, ...sum]));
}

/** Demo address of XRP account `account` (`m/44'/144'/account'/0/0`, like Rust). */
export function demoXrpAddress(seed: Uint8Array, account: number): string {
  const pk = HDKey.fromMasterSeed(seed).derive(`m/44'/144'/${account}'/0/0`).publicKey;
  if (!pk) throw new IpcError('INTERNAL', l10n('dérivation XRP', 'XRP derivation'));
  return xrpAddressOfId(bitcoin.crypto.hash160(pk));
}

const invalidInput = (m: string) => new IpcError('INVALID_INPUT', l10n(`Entrée invalide : ${m}`, `Invalid input: ${m}`));
const unreachable = (m: string) => new IpcError('SERVER_UNREACHABLE', l10n(`Serveur injoignable : ${m}`, `Server unreachable: ${m}`));
const has = (s: string, w: string) => s.toLowerCase().includes(w);
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};
const xrpText = (drops: bigint | string) => {
  const v = BigInt(drops);
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${v / 1_000_000n}${frac ? `,${frac}` : ''} XRP`;
};

/** wallet-core `xrp_account_id`: X-addresses refused, checksum verified (same messages as Rust). */
export function checkXrpAddress(a: unknown): string {
  const s = String(a ?? '').trim();
  if ((s.startsWith('X') || s.startsWith('T')) && s.length >= 46) {
    throw invalidInput(l10n("les X-addresses ne sont pas prises en charge : demande l'adresse classique r… et le tag de destination", 'X-addresses are not supported: ask for the classic r… address and the destination tag'));
  }
  let raw: Uint8Array;
  try {
    raw = base58xrp.decode(s);
  } catch {
    throw invalidInput(l10n('adresse XRP invalide', 'invalid XRP address'));
  }
  if (raw.length !== 25 || raw[0] !== 0) throw invalidInput(l10n('adresse XRP invalide', 'invalid XRP address'));
  const sum = sha256(sha256(raw.slice(0, 21)));
  if (!raw.slice(21).every((b, i) => b === sum[i])) throw invalidInput(l10n('adresse XRP invalide (somme de contrôle)', 'invalid XRP address (checksum)'));
  return s;
}

interface DemoXrpAccount {
  balance: bigint;
  sequence: number;
  ownerCount: number;
  requireDestTag: boolean;
}

/** Demo Payment (hex JSON). `paths` / `deliverMin` / partial flag exist so the refusals can be tested. */
interface DemoPayment {
  account: string;
  destination: string;
  destinationTag: number | null;
  amount: XrpAmountView;
  fee: string;
  sequence: number;
  lastLedgerSequence: number | null;
  flags: number;
  paths?: unknown;
  deliverMin?: unknown;
  signature?: string;
}

export interface DemoXrpDeps {
  network: Network;
  seed: Uint8Array;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
  now: () => number;
}

export interface DemoXrpState {
  me: string;
  /** A funded account that requires a destination tag (an exchange's deposit address). */
  exchange: string;
  /** A funded account without any requirement. */
  friend: string;
  accounts: Map<string, DemoXrpAccount>;
  lines: Map<string, XrpTrustLine[]>;
  history: XrpHistoryEntry[];
  /** hash → submit time and final result. */
  submitted: Map<string, { at: number; result: string }>;
  ledger: number;
  /** Tests: the next submitted payment fails in the ledger with this code. */
  failNext: string | null;
}

export function createDemoXrp(d: DemoXrpDeps) {
  const netKey = d.network === 'mainnet' ? 'mainnet' : 'testnet';
  const me = demoXrpAddress(d.seed, 0);
  const idOf = (label: string) => xrpAddressOfId(sha256(new TextEncoder().encode(label)).slice(0, 20));
  const exchange = idOf('kyro-demo-xrp-exchange');
  const friend = idOf('kyro-demo-xrp-friend');
  const issuer = idOf('kyro-demo-xrp-issuer');
  const t0 = d.now();
  const state: DemoXrpState = {
    me,
    exchange,
    friend,
    accounts: new Map([
      // 2 owned objects (a trust line and an offer): reserve 1 + 2 × 0.2 = 1.4 XRP.
      [me, { balance: 85_000_000n, sequence: 4_812_307, ownerCount: 2, requireDestTag: false }],
      [exchange, { balance: 9_800_000_000_000n, sequence: 112, ownerCount: 0, requireDestTag: true }],
      [friend, { balance: 2_500_000_000n, sequence: 31, ownerCount: 0, requireDestTag: false }],
      [issuer, { balance: 50_000_000n, sequence: 9, ownerCount: 0, requireDestTag: false }],
    ]),
    lines: new Map([[me, [{ currency: 'USD', issuer, balance: '12.5', limit: '1000' }]]]),
    history: [
      // A withdrawal from the demo exchange (its deposit address requires a tag: try sending back to it).
      { hash: bytesToHex(sha256(new TextEncoder().encode('xrp-in-2'))).toUpperCase(), from: exchange, to: me, destinationTag: null, amount: { kind: 'xrp', drops: '25000000' }, fee: '12', ledger: 6_120_060, time: t0 - 86_400_000, result: 'tesSUCCESS' },
      { hash: bytesToHex(sha256(new TextEncoder().encode('xrp-in-1'))).toUpperCase(), from: friend, to: me, destinationTag: null, amount: { kind: 'xrp', drops: '60000000' }, fee: '12', ledger: 6_120_004, time: t0 - 3 * 86_400_000, result: 'tesSUCCESS' },
    ],
    submitted: new Map(),
    ledger: d.network === 'mainnet' ? 93_404_120 : 6_120_120,
    failNext: null,
  };

  const torOn = () => d.settings().tor.enabled;
  const serverOf = (): XrpServer => d.settings().servers.xrp?.[netKey] ?? { kind: 'default' };
  const defaultHost = d.network === 'mainnet' ? 'xrplcluster.com' : 's.altnet.rippletest.net';
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Gate of every read: the right server, Tor, no fallback. The ledger advances (~4 s). */
  const backend = async () => {
    const s = serverOf();
    if (s.kind === 'jsonRpc') {
      const bad = checkServerUrl(s.url, torOn());
      if (bad) throw new IpcError('SERVER_INVALID', l10n(`Serveur invalide : ${bad}`, `Invalid server: ${bad}`));
    }
    if (torOn()) await d.tor.waitReady();
    await wait(50 + Math.random() * 120);
    if (s.kind === 'jsonRpc' && has(s.url, 'down')) throw unreachable(l10n(`${hostOf(s.url)} : délai de connexion dépassé`, `${hostOf(s.url)}: connection timed out`));
    state.ledger = (d.network === 'mainnet' ? 93_404_120 : 6_120_120) + Math.floor((d.now() - t0) / 4000);
    return s;
  };

  const account = (address: string): XrpAccountInfo => {
    const a = state.accounts.get(address);
    if (!a) return { address, exists: false, balance: '0', sequence: 0, ownerCount: 0, flags: 0, requireDestTag: false, disallowXrp: false, reserve: '0', spendable: '0' };
    const reserve = XRP_RESERVE_BASE + XRP_RESERVE_INC * BigInt(a.ownerCount);
    const spendable = a.balance > reserve ? a.balance - reserve : 0n;
    return {
      address,
      exists: true,
      balance: a.balance.toString(),
      sequence: a.sequence,
      ownerCount: a.ownerCount,
      flags: a.requireDestTag ? 0x00020000 : 0,
      requireDestTag: a.requireDestTag,
      disallowXrp: false,
      reserve: reserve.toString(),
      spendable: spendable.toString(),
    };
  };

  /** xrp_backend::check_payment, same order and messages. */
  const checkPayment = (ours: XrpAccountInfo, dest: XrpAccountInfo, drops: bigint | null, fee: bigint, tag: number | null) => {
    if (!ours.exists) throw invalidInput(l10n('ton compte XRP n’est pas encore activé (aucun XRP reçu)', 'your XRP account is not activated yet (no XRP received)'));
    if (dest.requireDestTag && tag === null) {
      throw invalidInput(l10n('ce destinataire exige un tag de destination (lsfRequireDestTag) : ajoute-le, sinon le paiement serait refusé ou perdu', 'this recipient requires a destination tag (lsfRequireDestTag): add it, otherwise the payment would be refused or lost'));
    }
    if (drops !== null) {
      if (!dest.exists && drops < XRP_RESERVE_BASE) {
        throw invalidInput(l10n(`ce compte n’existe pas encore : il faut lui envoyer au moins la réserve de base (${xrpText(XRP_RESERVE_BASE).replace(' XRP', '')} XRP), sinon le paiement échoue (tecNO_DST_INSUF_XRP)`, `this account does not exist yet: you must send it at least the base reserve (${xrpText(XRP_RESERVE_BASE).replace(' XRP', '')} XRP), otherwise the payment fails (tecNO_DST_INSUF_XRP)`));
      }
      const spendable = BigInt(ours.spendable);
      if (drops + fee > spendable) {
        throw invalidInput(l10n(`solde disponible insuffisant : ${xrpText(spendable).replace(' XRP', '')} XRP disponibles (solde − réserve), il en faut ${xrpText(drops + fee).replace(' XRP', '')}`, `insufficient available balance: ${xrpText(spendable).replace(' XRP', '')} XRP available (balance − reserve), ${xrpText(drops + fee).replace(' XRP', '')} needed`));
      }
    } else if (!dest.exists) {
      throw invalidInput(l10n('un token ne peut pas être envoyé à un compte XRP qui n’existe pas (tecNO_DST)', 'a token cannot be sent to an XRP account that does not exist (tecNO_DST)'));
    }
  };

  const encode = (p: DemoPayment) => bytesToHex(new TextEncoder().encode(JSON.stringify(p))).toUpperCase();
  const hashOf = (blob: string) => bytesToHex(sha256(new TextEncoder().encode(`TXN\0${blob}`))).toUpperCase();

  /** wallet-core xrp_decode_tx: strict, Account = us, refuses Paths / DeliverMin / partial payments. */
  const decode = (blob: unknown): { p: DemoPayment; summary: XrpTxSummary } => {
    let p: DemoPayment;
    try {
      p = JSON.parse(new TextDecoder().decode(hexToBytes(String(blob ?? '').trim().toLowerCase()))) as DemoPayment;
    } catch {
      throw invalidInput(l10n('blob XRP illisible', 'unreadable XRP blob'));
    }
    if (p.account !== me) throw invalidInput(l10n("transaction XRP : l'Account n'est pas l'adresse de ce portefeuille", 'XRP transaction: the Account is not this wallet’s address'));
    checkXrpAddress(p.destination);
    if (p.paths !== undefined) throw invalidInput(l10n('transaction XRP : les chemins (Paths) ne sont pas pris en charge', 'XRP transaction: paths (Paths) are not supported'));
    if (p.deliverMin !== undefined) throw invalidInput(l10n("transaction XRP : DeliverMin (paiements partiels) n'est pas pris en charge", 'XRP transaction: DeliverMin (partial payments) is not supported'));
    if ((p.flags & TF_PARTIAL_PAYMENT) !== 0) throw invalidInput(l10n('transaction XRP : les paiements partiels (tfPartialPayment) sont refusés : le montant livré pourrait être presque nul', 'XRP transaction: partial payments (tfPartialPayment) are refused: the delivered amount could be almost zero'));
    if ((p.flags & ~TF_FULLY_CANONICAL_SIG) >>> 0 !== 0) throw invalidInput(l10n(`transaction XRP : flags inconnus 0x${((p.flags & ~TF_FULLY_CANONICAL_SIG) >>> 0).toString(16).padStart(8, '0')}`, `XRP transaction: unknown flags 0x${((p.flags & ~TF_FULLY_CANONICAL_SIG) >>> 0).toString(16).padStart(8, '0')}`));
    const warnings: XrpWarning[] = [];
    if (BigInt(p.fee) > 1_000_000n) warnings.push({ kind: 'highFee' });
    const summary: XrpTxSummary = {
      account: p.account,
      destination: p.destination,
      destinationTag: p.destinationTag,
      amount: p.amount,
      fee: p.fee,
      sequence: p.sequence,
      lastLedgerSequence: p.lastLedgerSequence,
      flags: p.flags,
      sendMax: null,
      sourceTag: null,
      invoiceId: null,
      memos: [],
      warnings,
      requiresExtraConfirmation: warnings.length > 0,
    };
    return { p, summary };
  };

  const dropsOf = (s: XrpTxSummary) => (s.amount.kind === 'xrp' ? BigInt(s.amount.drops) : null);

  const contextFor = (to: string): XrpContext => ({ account: account(me), destination: account(to), reserveBase: XRP_RESERVE_BASE.toString(), reserveInc: XRP_RESERVE_INC.toString() });

  /** commands_xrp.rs describe_xrp: the destination tag gets its own framed block. */
  const describe = (s: XrpTxSummary, c: XrpContext): string => {
    const line = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    let out = l10n(`Envoi XRP Ledger${d.network === 'testnet' ? ' (testnet)' : ''}\n\nÀ : ${s.destination}\n${line}\n`, `XRP Ledger transfer${d.network === 'testnet' ? ' (testnet)' : ''}\n\nTo: ${s.destination}\n${line}\n`);
    out += s.destinationTag !== null ? l10n(`TAG DE DESTINATION : ${s.destinationTag}\n`, `DESTINATION TAG: ${s.destinationTag}\n`) : l10n("AUCUN TAG DE DESTINATION\n(une plateforme d'échange ou un service en exige souvent un : sans lui, les fonds peuvent être perdus)\n", 'NO DESTINATION TAG\n(an exchange or a service often requires one: without it, the funds can be lost)\n');
    out += `${line}\n`;
    out += l10n(`Montant : ${s.amount.kind === 'xrp' ? `${xrpText(s.amount.drops)} (${s.amount.drops} drops)` : `${s.amount.value} ${s.amount.currency} (émis par ${s.amount.issuer})`}\n`, `Amount: ${s.amount.kind === 'xrp' ? `${xrpText(s.amount.drops)} (${s.amount.drops} drops)` : `${s.amount.value} ${s.amount.currency} (issued by ${s.amount.issuer})`}\n`);
    if (!c.destination.exists) out += l10n(`\nCe compte n'existe pas encore : ce paiement le crée (réserve de ${xrpText(c.reserveBase)} bloquée chez lui).\n`, `\nThis account does not exist yet: this payment creates it (reserve of ${xrpText(c.reserveBase)} locked on it).\n`);
    out += l10n(`\nFrais : ${xrpText(s.fee)} (${s.fee} drops)\nSolde : ${xrpText(c.account.balance)} · réserve bloquée : ${xrpText(c.account.reserve)} (${xrpText(c.reserveBase)} + ${xrpText(c.reserveInc)} × ${c.account.ownerCount} objet(s)) · disponible : ${xrpText(c.account.spendable)}\n`, `\nFees: ${xrpText(s.fee)} (${s.fee} drops)\nBalance: ${xrpText(c.account.balance)} · locked reserve: ${xrpText(c.account.reserve)} (${xrpText(c.reserveBase)} + ${xrpText(c.reserveInc)} × ${c.account.ownerCount} object(s)) · available: ${xrpText(c.account.spendable)}\n`);
    if (s.lastLedgerSequence !== null) out += l10n(`Valable jusqu'au registre n° ${s.lastLedgerSequence} (≈ 1 min), séquence ${s.sequence}\n`, `Valid until ledger no. ${s.lastLedgerSequence} (≈ 1 min), sequence ${s.sequence}\n`);
    return out;
  };

  const probe = async (network: string, s: XrpServer): Promise<ServerTestResult['detected']> => {
    if (network !== 'mainnet' && network !== 'testnet') throw new IpcError('SERVER_INVALID', l10n(`Serveur invalide : xrp : réseau inconnu « ${network} » (mainnet ou testnet)`, `Invalid server: xrp: unknown network “${network}” (mainnet or testnet)`));
    if (s.kind === 'jsonRpc') {
      const bad = checkServerUrl(s.url, torOn());
      if (bad) throw new IpcError('SERVER_INVALID', l10n(`Serveur invalide : xrp ${network} : ${bad}`, `Invalid server: xrp ${network}: ${bad}`));
    }
    if (torOn()) await d.tor.waitReady();
    await wait(100 + Math.random() * 200);
    if (s.kind === 'jsonRpc' && has(s.url, 'down')) throw unreachable(l10n(`${hostOf(s.url)} : délai de connexion dépassé`, `${hostOf(s.url)}: connection timed out`));
    if (s.kind === 'jsonRpc' && has(s.url, 'wrong')) {
      throw new IpcError('SERVER_WRONG_NETWORK', l10n(`Mauvais réseau : ce serveur XRPL est sur ${network === 'mainnet' ? 'testnet' : 'mainnet'}, pas sur ${network}`, `Wrong network: this XRPL server is on ${network === 'mainnet' ? 'testnet' : 'mainnet'}, not on ${network}`));
    }
    return { network, chainId: network === 'mainnet' ? 0 : 1, blockHeight: state.ledger };
  };

  const handlers: Record<Extract<keyof Commands, `xrp_${string}`>, (a: Record<string, unknown>) => unknown> = {
    xrp_backend_info: (): XrpBackendInfo => {
      const s = serverOf();
      return { kind: s.kind, network: netKey, label: s.kind === 'jsonRpc' ? hostOf(s.url) : defaultHost, tor: torOn() };
    },
    xrp_address: (a) => {
      d.requireUnlocked();
      if ((a.index ?? 0) !== 0) throw invalidInput(l10n('XRP : une seule adresse par compte (index 0)', 'XRP: a single address per account (index 0)'));
      const account = a.account === undefined ? 0 : Number(a.account);
      if (!Number.isInteger(account) || account < 0 || account > 100) throw invalidInput(l10n('numéro de compte : au plus 100', 'account number: at most 100'));
      return demoXrpAddress(d.seed, account);
    },
    xrp_account: async (a) => {
      const addr = checkXrpAddress(a.address);
      await backend();
      return account(addr);
    },
    xrp_lines: async (a) => {
      const addr = checkXrpAddress(a.address);
      await backend();
      return state.lines.get(addr) ?? [];
    },
    xrp_txs: async (a) => {
      const addr = checkXrpAddress(a.address);
      await backend();
      return state.history.filter((t) => t.from === addr || t.to === addr).slice(0, 50);
    },
    xrp_build_tx: async (a) => {
      d.requireUnlocked();
      const to = checkXrpAddress(a.to);
      const issued = a.issued as { currency: string; issuer: string } | undefined;
      const amountStr = String(a.amount ?? '').trim();
      let amount: XrpAmountView;
      if (!issued) {
        if (!/^\d+$/.test(amountStr) || BigInt(amountStr) <= 0n) throw invalidInput(l10n('montant en drops invalide', 'invalid amount in drops'));
        amount = { kind: 'xrp', drops: amountStr };
      } else {
        checkXrpAddress(issued.issuer);
        if (!/^\d+(\.\d+)?$/.test(amountStr) || Number(amountStr) <= 0) throw invalidInput(l10n('montant de la monnaie émise invalide', 'invalid issued currency amount'));
        amount = { kind: 'issued', value: amountStr, currency: issued.currency, issuer: issued.issuer };
      }
      const tag = a.destinationTag === undefined || a.destinationTag === null ? null : Number(a.destinationTag);
      if (tag !== null && (!Number.isInteger(tag) || tag < 0 || tag > 0xffffffff)) throw invalidInput(l10n('tag de destination invalide', 'invalid destination tag'));
      await backend();
      const context = contextFor(to);
      checkPayment(context.account, context.destination, amount.kind === 'xrp' ? BigInt(amount.drops) : null, FEE, tag);
      const p: DemoPayment = { account: me, destination: to, destinationTag: tag, amount, fee: FEE.toString(), sequence: context.account.sequence, lastLedgerSequence: state.ledger + LLS_OFFSET, flags: TF_FULLY_CANONICAL_SIG };
      const blob = encode(p);
      return { blob, summary: decode(blob).summary, context };
    },
    xrp_sign_tx: async (a) => {
      d.requireUnlocked();
      const { p, summary } = decode(a.blob);
      await backend();
      const context = contextFor(summary.destination);
      if (summary.lastLedgerSequence !== null && summary.lastLedgerSequence <= state.ledger) throw invalidInput(l10n('paiement XRP expiré (LastLedgerSequence dépassé) : reconstruis-le', 'XRP payment expired (LastLedgerSequence passed): rebuild it'));
      if (summary.sequence !== context.account.sequence) throw invalidInput(l10n('numéro de séquence périmé : reconstruis le paiement', 'stale sequence number: rebuild the payment'));
      checkPayment(context.account, context.destination, dropsOf(summary), BigInt(summary.fee), summary.destinationTag);
      d.checkPassword(a.password);
      if (!d.confirm(l10n(`Confirmer le paiement XRP\n${describe(summary, context)}`, `Confirm the XRP payment\n${describe(summary, context)}`))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      if (summary.requiresExtraConfirmation && !d.confirm(l10n('Attention : paiement à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?', 'Warning: payment to check\nOnly sign if you know exactly why. Sign anyway?'))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      const signed = encode({ ...p, signature: bytesToHex(sha256(new TextEncoder().encode(`sig:${String(a.blob)}`))) });
      return { blob: signed, hash: hashOf(signed), summary, context };
    },
    xrp_broadcast: async (a) => {
      const { p, summary } = decode(a.blob);
      if (!p.signature) throw invalidInput(l10n('transaction XRP non signée', 'unsigned XRP transaction'));
      await backend();
      const hash = hashOf(String(a.blob).trim().toUpperCase());
      const ours = state.accounts.get(me);
      const ctx = contextFor(summary.destination);
      if (!ours || summary.sequence !== ours.sequence) throw invalidInput(l10n('paiement XRP refusé : tefPAST_SEQ (This sequence number has already passed.)', 'XRP payment refused: tefPAST_SEQ (This sequence number has already passed.)'));
      try {
        checkPayment(ctx.account, ctx.destination, dropsOf(summary), BigInt(summary.fee), summary.destinationTag);
      } catch {
        throw invalidInput(l10n('paiement XRP refusé : tecUNFUNDED_PAYMENT (Insufficient XRP balance to send.)', 'XRP payment refused: tecUNFUNDED_PAYMENT (Insufficient XRP balance to send.)'));
      }
      const result = state.failNext ?? 'tesSUCCESS';
      state.failNext = null;
      // Fee and sequence are consumed whatever the ledger result (tec*); the amount only on success.
      ours.balance -= BigInt(summary.fee);
      ours.sequence += 1;
      if (result === 'tesSUCCESS' && summary.amount.kind === 'xrp') {
        const drops = BigInt(summary.amount.drops);
        ours.balance -= drops;
        const dest = state.accounts.get(summary.destination);
        if (dest) dest.balance += drops;
        else state.accounts.set(summary.destination, { balance: drops, sequence: state.ledger, ownerCount: 0, requireDestTag: false });
      }
      state.submitted.set(hash, { at: d.now(), result });
      state.history.unshift({ hash, from: me, to: summary.destination, destinationTag: summary.destinationTag, amount: result === 'tesSUCCESS' ? summary.amount : null, fee: summary.fee, ledger: state.ledger + 1, time: d.now(), result });
      return hash;
    },
    xrp_tx_status: async (a) => {
      const h = String(a.hash ?? '').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(h)) throw invalidInput(l10n('hash : 64 caractères hexadécimaux', 'hash: 64 hexadecimal characters'));
      await backend();
      const s = state.submitted.get(h.toUpperCase());
      if (!s) return { validated: false, result: '' };
      return d.now() - s.at >= VALIDATION_MS ? { validated: true, result: s.result } : { validated: false, result: '' };
    },
  };

  return {
    state,
    handlers,
    probe,
    validate: (servers: Settings['servers'], tor: boolean) => {
      for (const nk of ['mainnet', 'testnet'] as const) {
        const s = servers.xrp?.[nk];
        if (s?.kind === 'jsonRpc') {
          const bad = checkServerUrl(s.url, tor);
          if (bad) throw new IpcError('SERVER_INVALID', l10n(`Serveur invalide : xrp ${nk} : ${bad}`, `Invalid server: xrp ${nk}: ${bad}`));
        }
      }
    },
  };
}
