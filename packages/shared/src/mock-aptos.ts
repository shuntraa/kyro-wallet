// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — Aptos (`aptos_*`, docs/IPC.md §2.11), mirroring apps/desktop/src-tauri/src/
// commands_aptos.rs and aptos_backend.rs. The address is a demo value (`0x` + SHA3-256 of a
// label, NOT the SLIP-10 key of the demo phrase); the transaction is a demo encoding (hex JSON,
// NOT the BCS wallet-core writes) and the signature is fake. The rules are Rust's:
// - only `0x1::aptos_account::transfer` of APT, full `0x` + 64 hex addresses (no short form, no ANS);
// - max fee = max gas (simulated gas × 1.5, at least 200) × gas price, reserved up front:
//   amount + max fee > balance → refused;
// - sign re-reads everything live, refuses an expired transaction or a stale sequence number;
// - a submitted transfer is committed a few seconds later (`aptos_tx_status`).

import { sha3_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import {
  IpcError,
  type AptosAccountInfo,
  type AptosBackendInfo,
  type AptosContext,
  type AptosHistoryEntry,
  type AptosTxSummary,
  type AptosWarning,
  type Commands,
  type Network,
  type Settings,
} from './ipc';
import type { DemoTor } from './mock-tor';
import { l10n } from './i18n';

export const APTOS_TRANSFER_FUNCTION = '0x1::aptos_account::transfer';
const GAS_PRICE = 100n;
/** Simulated gas of a transfer to an existing account / to a new one. */
const GAS_EXISTING = 11n;
const GAS_NEW = 1_000n;
const MIN_MAX_GAS = 200n;
const EXPIRATION_SECS = 600;
const HIGH_FEE = 2_000_000n;
/** Demo: a submitted transfer is committed after this long. */
const COMMIT_MS = 3_000;

/** Demo address of Aptos account `account` (label hash, not a real derivation). */
export function demoAptosAddress(account: number): string {
  return `0x${bytesToHex(sha3_256(new TextEncoder().encode(`kyro-demo-aptos-account-${account}`)))}`;
}

const invalidInput = (m: string) => new IpcError('INVALID_INPUT', l10n(`Entrée invalide : ${m}`, `Invalid input: ${m}`));
const aptText = (octas: bigint | string) => {
  const v = BigInt(octas);
  const frac = (v % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${v / 100_000_000n}${frac ? `,${frac}` : ''} APT`;
};

/** wallet-core `aptos_parse_address`: `0x` + exactly 64 hex, same messages as Rust. */
export function checkAptosAddress(a: unknown): string {
  const s = String(a ?? '').trim();
  if (s.endsWith('.apt')) throw invalidInput(l10n("les noms ANS (.apt) ne sont pas pris en charge : colle l'adresse 0x… complète", 'ANS names (.apt) are not supported: paste the full 0x… address'));
  if (!s.startsWith('0x')) throw invalidInput(l10n('adresse Aptos invalide : 0x suivi de 64 caractères hexadécimaux attendu', 'invalid Aptos address: 0x followed by 64 hexadecimal characters expected'));
  const h = s.slice(2);
  if (h.length !== 64) throw invalidInput(l10n('adresse Aptos invalide : 64 caractères hexadécimaux attendus après 0x (forme courte refusée : demande l’adresse complète)', 'invalid Aptos address: 64 hexadecimal characters expected after 0x (short form refused: ask for the full address)'));
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw invalidInput(l10n('adresse Aptos invalide (caractère non hexadécimal)', 'invalid Aptos address (non-hexadecimal character)'));
  return `0x${h.toLowerCase()}`;
}

interface DemoAptosAccount {
  balance: bigint;
  sequence: bigint;
}

interface DemoTransfer {
  sender: string;
  recipient: string;
  amount: string;
  sequenceNumber: string;
  maxGasAmount: string;
  gasUnitPrice: string;
  expirationTimestampSecs: number;
  chainId: number;
  signature?: string;
}

export interface DemoAptosDeps {
  network: Network;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
  now: () => number;
}

export interface DemoAptosState {
  me: string;
  /** A funded account. */
  friend: string;
  accounts: Map<string, DemoAptosAccount>;
  history: AptosHistoryEntry[];
  /** hash → submit time and result. */
  submitted: Map<string, { at: number; success: boolean }>;
  /** Tests: the next submitted transfer fails on chain. */
  failNext: boolean;
}

export function createDemoAptos(d: DemoAptosDeps) {
  const netKey = d.network === 'mainnet' ? 'mainnet' : 'testnet';
  const chainId = d.network === 'mainnet' ? 1 : 2;
  const me = demoAptosAddress(0);
  const friend = `0x${bytesToHex(sha3_256(new TextEncoder().encode('kyro-demo-aptos-friend')))}`;
  const t0 = d.now();
  const state: DemoAptosState = {
    me,
    friend,
    accounts: new Map([
      [me, { balance: 1_250_000_000n, sequence: 3n }],
      [friend, { balance: 40_000_000_000n, sequence: 17n }],
    ]),
    history: [
      { version: '3100000001', hash: null, time: t0 - 86_400_000, direction: 'in', amount: '1500000000', fee: '0', counterparty: null, success: true, function: APTOS_TRANSFER_FUNCTION, sentByUs: false },
      { version: '3100000420', hash: `0x${'5a'.repeat(32)}`, time: t0 - 3_600_000, direction: 'out', amount: '250000000', fee: '1100', counterparty: friend, success: true, function: APTOS_TRANSFER_FUNCTION, sentByUs: true },
      // Address-poisoning dust: 1 octa from a look-alike, not signed by us.
      { version: '3100000777', hash: null, time: t0 - 600_000, direction: 'in', amount: '1', fee: '0', counterparty: null, success: true, function: APTOS_TRANSFER_FUNCTION, sentByUs: false },
    ],
    submitted: new Map(),
    failNext: false,
  };
  const torOn = () => d.settings().tor.enabled;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const backend = async () => {
    if (torOn()) await d.tor.waitReady();
    if (typeof window !== 'undefined') await wait(150);
  };
  const nowSecs = () => Math.floor(d.now() / 1000);

  const account = (address: string): AptosAccountInfo => {
    const a = state.accounts.get(address);
    return { address, balance: (a?.balance ?? 0n).toString(), sequenceNumber: (a?.sequence ?? 0n).toString(), authenticationKey: address, keyMatches: true };
  };
  const recipientNew = (to: string) => !state.accounts.has(to);
  const gasFor = (to: string) => (recipientNew(to) ? GAS_NEW : GAS_EXISTING);
  const maxGasFor = (gas: bigint) => {
    const g = (gas * 3n + 1n) / 2n;
    return g < MIN_MAX_GAS ? MIN_MAX_GAS : g;
  };
  /** aptos_backend::check_transfer, same messages. */
  const checkTransfer = (ours: AptosAccountInfo, amount: bigint, maxFee: bigint) => {
    const balance = BigInt(ours.balance);
    if (amount + maxFee > balance) {
      throw invalidInput(l10n(`solde insuffisant : ${aptText(balance).replace(' APT', '')} APT disponibles, il en faut ${aptText(amount + maxFee).replace(' APT', '')} (montant + frais maximum, que le réseau exige d'avance)`, `insufficient balance: ${aptText(balance).replace(' APT', '')} APT available, ${aptText(amount + maxFee).replace(' APT', '')} needed (amount + maximum fee, which the network requires upfront)`));
    }
  };
  const encode = (t: DemoTransfer) => bytesToHex(new TextEncoder().encode(JSON.stringify(t)));
  const hashOf = (signed: string) => `0x${bytesToHex(sha3_256(new TextEncoder().encode(`APTOS::Transaction${signed}`)))}`;
  const decode = (raw: unknown): { t: DemoTransfer; summary: AptosTxSummary } => {
    let t: DemoTransfer;
    try {
      const hex = String(raw ?? '').trim();
      const bytes = new Uint8Array((hex.match(/../g) ?? []).map((b) => parseInt(b, 16)));
      t = JSON.parse(new TextDecoder().decode(bytes)) as DemoTransfer;
    } catch {
      throw invalidInput(l10n('transaction Aptos refusée : données illisibles', 'Aptos transaction refused: unreadable data'));
    }
    if (t.sender !== me) throw invalidInput(l10n("transaction Aptos refusée : l'expéditeur n'est pas l'adresse de ce compte", 'Aptos transaction refused: the sender is not the address of this account'));
    checkAptosAddress(t.recipient);
    const maxFee = BigInt(t.maxGasAmount) * BigInt(t.gasUnitPrice);
    const warnings: AptosWarning[] = [];
    if (t.recipient === t.sender) warnings.push({ kind: 'selfTransfer' });
    if (maxFee > HIGH_FEE) warnings.push({ kind: 'highFee' });
    return {
      t,
      summary: {
        sender: t.sender,
        recipient: t.recipient,
        function: APTOS_TRANSFER_FUNCTION,
        amount: t.amount,
        sequenceNumber: t.sequenceNumber,
        maxGasAmount: t.maxGasAmount,
        gasUnitPrice: t.gasUnitPrice,
        maxFee: maxFee.toString(),
        expirationTimestampSecs: t.expirationTimestampSecs,
        chainId: t.chainId,
        warnings,
        requiresExtraConfirmation: warnings.length > 0,
      },
    };
  };
  const contextFor = (to: string): AptosContext => ({ account: account(me), recipientNew: recipientNew(to), gasUsed: gasFor(to).toString(), ledgerTime: nowSecs() });
  const describe = (s: AptosTxSummary, c: AptosContext) =>
    l10n(`Envoi Aptos${d.network === 'testnet' ? ' (testnet)' : ''}\n\nÀ : ${s.recipient}\n\nMontant : ${aptText(s.amount)} (${s.amount} octas)\n${c.recipientNew ? "Ce compte n'a encore rien reçu : le transfert le crée.\n" : ''}\nFrais maximum : ${aptText(s.maxFee)}\nSolde : ${aptText(c.account.balance)}\nFonction : ${s.function}\nSéquence ${s.sequenceNumber} · chaîne ${s.chainId}`, `Aptos send${d.network === 'testnet' ? ' (testnet)' : ''}\n\nTo: ${s.recipient}\n\nAmount: ${aptText(s.amount)} (${s.amount} octas)\n${c.recipientNew ? 'This account has not received anything yet: the transfer creates it.\n' : ''}\nMaximum fee: ${aptText(s.maxFee)}\nBalance: ${aptText(c.account.balance)}\nFunction: ${s.function}\nSequence ${s.sequenceNumber} · chain ${s.chainId}`);

  const handlers: Record<Extract<keyof Commands, `aptos_${string}`>, (a: Record<string, unknown>) => unknown> = {
    aptos_backend_info: (): AptosBackendInfo => ({ network: netKey, label: d.network === 'mainnet' ? 'api.mainnet.aptoslabs.com' : 'api.testnet.aptoslabs.com', tor: torOn() }),
    aptos_address: (a) => {
      d.requireUnlocked();
      const n = a.account === undefined ? 0 : Number(a.account);
      if (!Number.isInteger(n) || n < 0 || n > 100) throw invalidInput(l10n('numéro de compte : au plus 100', 'account number: at most 100'));
      return demoAptosAddress(n);
    },
    aptos_account: async (a) => {
      const addr = checkAptosAddress(a.address);
      await backend();
      return account(addr);
    },
    aptos_txs: async (a) => {
      const addr = checkAptosAddress(a.address);
      await backend();
      return addr === me ? state.history.slice(0, 50) : [];
    },
    aptos_build_tx: async (a) => {
      d.requireUnlocked();
      const to = checkAptosAddress(a.to);
      const amountStr = String(a.amount ?? '').trim();
      if (!/^\d+$/.test(amountStr) || BigInt(amountStr) <= 0n) throw invalidInput(l10n('montant en octas invalide', 'invalid amount in octas'));
      await backend();
      const context = contextFor(to);
      checkTransfer(context.account, BigInt(amountStr), 0n);
      const maxGas = maxGasFor(gasFor(to));
      checkTransfer(context.account, BigInt(amountStr), maxGas * GAS_PRICE);
      const t: DemoTransfer = { sender: me, recipient: to, amount: amountStr, sequenceNumber: context.account.sequenceNumber, maxGasAmount: maxGas.toString(), gasUnitPrice: GAS_PRICE.toString(), expirationTimestampSecs: nowSecs() + EXPIRATION_SECS, chainId };
      const raw = encode(t);
      return { raw, summary: decode(raw).summary, context };
    },
    aptos_sign_tx: async (a) => {
      d.requireUnlocked();
      const { t, summary } = decode(a.raw);
      await backend();
      const context = contextFor(summary.recipient);
      if (summary.chainId !== chainId) throw invalidInput(l10n(`transaction pour la chaîne ${summary.chainId}, pas pour celle de l'app (${chainId})`, `transaction for chain ${summary.chainId}, not for the app's (${chainId})`));
      if (summary.expirationTimestampSecs < nowSecs() + 30) throw invalidInput(l10n("transfert Aptos expiré ou sur le point de l'être : reconstruis-le", 'Aptos transfer expired or about to be: rebuild it'));
      if (summary.sequenceNumber !== context.account.sequenceNumber) throw invalidInput(l10n('numéro de séquence périmé : reconstruis le transfert', 'stale sequence number: rebuild the transfer'));
      checkTransfer(context.account, BigInt(summary.amount), BigInt(summary.maxFee));
      d.checkPassword(a.password);
      if (!d.confirm(l10n(`Confirmer l'envoi d'APT\n${describe(summary, context)}`, `Confirm the APT send\n${describe(summary, context)}`))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      if (summary.requiresExtraConfirmation && !d.confirm(l10n('Attention : transfert à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?', 'Warning: transfer to check\nOnly sign if you know exactly why. Sign anyway?'))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      const signed = encode({ ...t, signature: bytesToHex(sha3_256(new TextEncoder().encode(`sig:${String(a.raw)}`))) });
      return { signed, hash: hashOf(signed), summary, context };
    },
    aptos_broadcast: async (a) => {
      const { t, summary } = decode(a.signed);
      if (!t.signature) throw invalidInput(l10n('transaction Aptos non signée', 'unsigned Aptos transaction'));
      await backend();
      const hash = hashOf(String(a.signed).trim());
      const ours = state.accounts.get(me);
      if (!ours || BigInt(summary.sequenceNumber) !== ours.sequence) throw invalidInput(l10n('transaction Aptos refusée par le nœud (HTTP 400) : SEQUENCE_NUMBER_TOO_OLD', 'Aptos transaction rejected by the node (HTTP 400): SEQUENCE_NUMBER_TOO_OLD'));
      if (summary.expirationTimestampSecs < nowSecs()) throw invalidInput(l10n('transaction Aptos refusée par le nœud (HTTP 400) : TRANSACTION_EXPIRED', 'Aptos transaction rejected by the node (HTTP 400): TRANSACTION_EXPIRED'));
      const success = !state.failNext;
      state.failNext = false;
      const to = summary.recipient;
      const gas = gasFor(to);
      const fee = gas * BigInt(summary.gasUnitPrice);
      ours.balance -= fee;
      ours.sequence += 1n;
      if (success) {
        const amount = BigInt(summary.amount);
        ours.balance -= amount;
        const dest = state.accounts.get(to);
        if (dest) dest.balance += amount;
        else state.accounts.set(to, { balance: amount, sequence: 0n });
      }
      state.submitted.set(hash, { at: d.now(), success });
      state.history.unshift({ version: String(3_100_001_000 + state.submitted.size), hash, time: d.now(), direction: 'out', amount: success ? summary.amount : '0', fee: fee.toString(), counterparty: to, success, function: APTOS_TRANSFER_FUNCTION, sentByUs: true });
      return hash;
    },
    aptos_tx_status: async (a) => {
      const h = String(a.hash ?? '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(h)) throw invalidInput(l10n('hash : 0x suivi de 64 caractères hexadécimaux', 'hash: 0x followed by 64 hexadecimal characters'));
      await backend();
      const s = state.submitted.get(h);
      if (!s || d.now() - s.at < COMMIT_MS) return { committed: false, success: false, vmStatus: '' };
      return { committed: true, success: s.success, vmStatus: s.success ? 'Executed successfully' : 'Move abort in 0x1::coin: EINSUFFICIENT_BALANCE(0x10006)' };
    },
  };

  return { state, handlers };
}
