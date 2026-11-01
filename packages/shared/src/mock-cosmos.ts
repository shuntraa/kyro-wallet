// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — Cosmos Hub (`cosmos_*`, docs/IPC.md §2.11), mirroring apps/desktop/src-tauri/src/
// commands_cosmos.rs and cosmos_backend.rs. The address is really derived (m/44'/118'/0'/0/0,
// bech32 `cosmos` of RIPEMD160(SHA256(pubkey))); the SignDoc is a demo encoding (hex JSON, NOT the
// protobuf wallet-core writes) and the signature is fake. The rules are Rust's:
// - MsgSend of uatom only; memo ≤ 512 characters; self-send refused;
// - gas = simulated × 1.4, fee = gas × 0.005 uatom × 1.2; timeout_height = latest + 100 blocks;
// - amount + fee > spendable → refused; our account unknown to the chain → refused;
// - sign re-reads the account live, refuses a stale sequence or an expired timeout height;
// - a broadcast transaction is in a block a few seconds later (`cosmos_tx_status`).

import { HDKey } from '@scure/bip32';
import * as bitcoin from 'bitcoinjs-lib';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  IpcError,
  type Commands,
  type CosmosAccountInfo,
  type CosmosBackendInfo,
  type CosmosContext,
  type CosmosHistoryEntry,
  type CosmosTxSummary,
  type CosmosWarning,
  type Network,
  type Settings,
} from './ipc';
import { l10n } from './i18n';
import type { DemoTor } from './mock-tor';
import { cosmosAddressOfBytes, cosmosAddressProblem } from './cosmos';

const GAS_USED = 88_412;
const TIMEOUT_BLOCKS = 100;
const MAX_MEMO = 512;
/** Demo: a broadcast transaction is in a block after this long. */
const INCLUSION_MS = 6_000;

/** Demo address of Cosmos account `account` (`m/44'/118'/account'/0/0`, like Rust). */
export function demoCosmosAddress(seed: Uint8Array, account: number): string {
  const pk = HDKey.fromMasterSeed(seed).derive(`m/44'/118'/${account}'/0/0`).publicKey;
  if (!pk) throw new IpcError('INTERNAL', l10n('dérivation Cosmos', 'Cosmos derivation'));
  return cosmosAddressOfBytes(bitcoin.crypto.hash160(pk));
}

const invalidInput = (m: string) => new IpcError('INVALID_INPUT', l10n(`Entrée invalide : ${m}`, `Invalid input: ${m}`));

/** wallet-core `cosmos_normalize_address`: bech32 checksum, prefix `cosmos`, 20 or 32 bytes. */
export function checkCosmosAddress(a: unknown): string {
  const s = String(a ?? '').trim();
  const problem = cosmosAddressProblem(s);
  if (problem) throw invalidInput(problem);
  return s.toLowerCase();
}

/** wallet-core `sanitize_text` (simplified): line breaks → space, controls → U+FFFD, invisibles removed. */
function cleanText(s: string): string {
  let out = '';
  for (const c of s) {
    const n = c.codePointAt(0) ?? 0;
    if (c === '\n' || c === '\r' || c === '\t') out += ' ';
    else if (n < 0x20 || (n >= 0x7f && n <= 0x9f)) out += '�';
    else if ((n >= 0x200b && n <= 0x200f) || (n >= 0x202a && n <= 0x202e) || (n >= 0x2060 && n <= 0x206f) || n === 0xfeff) continue;
    else out += c;
  }
  return out;
}

const atomText = (uatom: bigint | string) => {
  const v = BigInt(uatom);
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${v / 1_000_000n}${frac ? `,${frac}` : ''} ATOM`;
};

interface DemoCosmosAccount {
  accountNumber: number;
  sequence: number;
  balance: bigint;
}

/** Demo SignDoc (hex JSON). */
interface DemoSignDoc {
  chainId: string;
  accountNumber: number;
  sequence: number;
  from: string;
  to: string;
  amount: string;
  fee: string;
  gasLimit: number;
  memo: string;
  timeoutHeight: number;
  signature?: string;
}

export interface DemoCosmosDeps {
  network: Network;
  seed: Uint8Array;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
  now: () => number;
}

export interface DemoCosmosState {
  me: string;
  /** An exchange deposit address (send to it with a memo). */
  exchange: string;
  accounts: Map<string, DemoCosmosAccount>;
  history: CosmosHistoryEntry[];
  /** hash → broadcast time and final code. */
  submitted: Map<string, { at: number; code: number }>;
  height: number;
  /** Tests: the next broadcast transaction fails in its block with this code. */
  failNext: number | null;
}

export function createDemoCosmos(d: DemoCosmosDeps) {
  const chainId = d.network === 'mainnet' ? 'cosmoshub-4' : 'provider';
  const baseHeight = d.network === 'mainnet' ? 33_672_841 : 19_664_240;
  const me = demoCosmosAddress(d.seed, 0);
  const idOf = (label: string) => cosmosAddressOfBytes(sha256(new TextEncoder().encode(label)).slice(0, 20));
  const exchange = idOf('kyro-demo-cosmos-exchange');
  const friend = idOf('kyro-demo-cosmos-friend');
  const t0 = d.now();
  const hashOf = (label: string) => bytesToHex(sha256(new TextEncoder().encode(label))).toUpperCase();
  const state: DemoCosmosState = {
    me,
    exchange,
    accounts: new Map([
      [me, { accountNumber: 30_881, sequence: 7, balance: 42_350_000n }],
      [exchange, { accountNumber: 17, sequence: 912_004, balance: 9_000_000_000_000n }],
      [friend, { accountNumber: 1_204, sequence: 3, balance: 120_000_000n }],
    ]),
    history: [
      { hash: hashOf('cosmos-in-2'), height: baseHeight - 14_000, time: t0 - 86_400_000, from: exchange, to: me, amount: '30000000', fee: '0', memo: '', success: true },
      { hash: hashOf('cosmos-in-1'), height: baseHeight - 50_000, time: t0 - 4 * 86_400_000, from: friend, to: me, amount: '12350000', fee: '0', memo: 'merci !', success: true },
    ],
    submitted: new Map(),
    height: baseHeight,
    failNext: null,
  };

  const torOn = () => d.settings().tor.enabled;
  const defaultHost = d.network === 'mainnet' ? 'cosmos-rest.publicnode.com' : 'rest.provider-sentry-01.hub-testnet.polypore.xyz';
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Gate of every read: Tor, no fallback. Blocks advance (~6 s). */
  const backend = async () => {
    if (torOn()) await d.tor.waitReady();
    await wait(50 + Math.random() * 120);
    state.height = baseHeight + Math.floor((d.now() - t0) / 6000);
  };

  const account = (address: string): CosmosAccountInfo => {
    const a = state.accounts.get(address);
    if (!a) return { address, exists: false, accountNumber: 0, sequence: 0, pubKey: null, balance: '0', spendable: '0' };
    return { address, exists: true, accountNumber: a.accountNumber, sequence: a.sequence, pubKey: null, balance: a.balance.toString(), spendable: a.balance.toString() };
  };

  /** cosmos_backend::check_send, same messages. */
  const checkSend = (ours: CosmosAccountInfo, amount: bigint, fee: bigint) => {
    if (!ours.exists) throw invalidInput(l10n('ton compte Cosmos n’est pas encore connu du réseau (aucun ATOM reçu)', 'your Cosmos account is not known to the network yet (no ATOM received)'));
    const spendable = BigInt(ours.spendable);
    if (amount + fee > spendable) {
      throw invalidInput(l10n(`solde disponible insuffisant : ${atomText(spendable).replace(' ATOM', '')} ATOM disponibles, il en faut ${atomText(amount + fee).replace(' ATOM', '')} (montant + frais)`, `insufficient available balance: ${atomText(spendable).replace(' ATOM', '')} ATOM available, ${atomText(amount + fee).replace(' ATOM', '')} needed (amount + fee)`));
    }
  };

  const encode = (p: DemoSignDoc) => bytesToHex(new TextEncoder().encode(JSON.stringify(p)));

  /** wallet-core cosmos_decode_sign_doc: our address, the network's chain id, uatom, timeout set. */
  const decode = (hex: unknown): { p: DemoSignDoc; summary: CosmosTxSummary } => {
    let p: DemoSignDoc;
    try {
      p = JSON.parse(new TextDecoder().decode(hexToBytes(String(hex ?? '').trim().toLowerCase()))) as DemoSignDoc;
    } catch {
      throw invalidInput(l10n('SignDoc : hexadécimal attendu', 'SignDoc: hexadecimal expected'));
    }
    if (p.chainId !== chainId) throw invalidInput(l10n(`transaction Cosmos : chain-id « ${p.chainId} » au lieu de « ${chainId} »`, `Cosmos transaction: chain-id “${p.chainId}” instead of “${chainId}”`));
    if (p.from !== me) throw invalidInput(l10n("transaction Cosmos : l'expéditeur n'est pas l'adresse de ce compte", 'Cosmos transaction: the sender is not the address of this account'));
    if (checkCosmosAddress(p.to) === me) throw invalidInput(l10n('transaction Cosmos : envoi à soi-même', 'Cosmos transaction: send to yourself'));
    if (!p.timeoutHeight) throw invalidInput(l10n('transaction Cosmos : timeout_height absent : la transaction resterait valable indéfiniment', 'Cosmos transaction: timeout_height missing: the transaction would stay valid forever'));
    if ([...p.memo].length > MAX_MEMO) throw invalidInput(l10n(`transaction Cosmos : mémo de plus de ${MAX_MEMO} caractères`, `Cosmos transaction: memo longer than ${MAX_MEMO} characters`));
    const warnings: CosmosWarning[] = [];
    if (BigInt(p.fee) > 100_000n) warnings.push({ kind: 'highFee' });
    const clean = cleanText(p.memo);
    if (clean !== p.memo) warnings.push({ kind: 'unusualText' });
    const summary: CosmosTxSummary = {
      chainId: p.chainId,
      accountNumber: p.accountNumber,
      sequence: p.sequence,
      from: p.from,
      to: p.to,
      amount: p.amount,
      fee: p.fee,
      gasLimit: p.gasLimit,
      memo: p.memo ? clean : null,
      memoHex: p.memo ? bytesToHex(new TextEncoder().encode(p.memo)) : null,
      timeoutHeight: p.timeoutHeight,
      warnings,
      requiresExtraConfirmation: warnings.length > 0,
    };
    return { p, summary };
  };

  const contextNow = (): CosmosContext => ({ account: account(me), height: state.height });

  /** commands_cosmos.rs describe_cosmos: memo framed, after the amount and the fee. */
  const describe = (s: CosmosTxSummary, c: CosmosContext): string => {
    const line = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    const left = BigInt(c.account.spendable) - BigInt(s.amount) - BigInt(s.fee);
    let out = l10n(`Envoi Cosmos Hub${d.network === 'testnet' ? ' (testnet)' : ''}\n\nÀ : ${s.to}\n\nMontant : ${atomText(s.amount)} (${s.amount} uatom)\n`, `Cosmos Hub send${d.network === 'testnet' ? ' (testnet)' : ''}\n\nTo: ${s.to}\n\nAmount: ${atomText(s.amount)} (${s.amount} uatom)\n`);
    out += l10n(`Frais : ${atomText(s.fee)} (${s.fee} uatom, gas maximum ${s.gasLimit})\nDisponible : ${atomText(c.account.spendable)} · après l'envoi : ${atomText(left > 0n ? left : 0n)}\n`, `Fee: ${atomText(s.fee)} (${s.fee} uatom, maximum gas ${s.gasLimit})\nAvailable: ${atomText(c.account.spendable)} · after the send: ${atomText(left > 0n ? left : 0n)}\n`);
    out += l10n(`Réseau : chain-id « ${s.chainId} » · compte n° ${s.accountNumber} · séquence ${s.sequence}\nValable jusqu'au bloc n° ${s.timeoutHeight} (≈ ${Math.ceil(((s.timeoutHeight - c.height) * 6) / 60)} min)\n`, `Network: chain-id “${s.chainId}” · account no. ${s.accountNumber} · sequence ${s.sequence}\nValid until block no. ${s.timeoutHeight} (≈ ${Math.ceil(((s.timeoutHeight - c.height) * 6) / 60)} min)\n`);
    out += `\n${line}\n`;
    out += s.memo !== null ? l10n(`MÉMO (public à jamais) : « ${s.memo} »\n`, `MEMO (public forever): “${s.memo}”\n`) : l10n("AUCUN MÉMO\n(une plateforme d'échange en exige souvent un : sans lui, les fonds peuvent être perdus)\n", 'NO MEMO\n(an exchange often requires one: without it, the funds may be lost)\n');
    return out + line;
  };

  const accountArg = (a: Record<string, unknown>) => {
    const account = a.account === undefined ? 0 : Number(a.account);
    if (!Number.isInteger(account) || account < 0 || account > 100) throw invalidInput(l10n('numéro de compte : au plus 100', 'account number: at most 100'));
    return account;
  };

  const handlers: Record<Extract<keyof Commands, `cosmos_${string}`>, (a: Record<string, unknown>) => unknown> = {
    cosmos_backend_info: (): CosmosBackendInfo => ({ kind: 'default', network: d.network, label: defaultHost, chainId, tor: torOn() }),
    cosmos_address: (a) => {
      d.requireUnlocked();
      return demoCosmosAddress(d.seed, accountArg(a));
    },
    cosmos_account: async (a) => {
      const addr = checkCosmosAddress(a.address);
      await backend();
      return account(addr);
    },
    cosmos_txs: async (a) => {
      const addr = checkCosmosAddress(a.address);
      await backend();
      return state.history.filter((t) => t.from === addr || t.to === addr).slice(0, 50);
    },
    cosmos_build_tx: async (a) => {
      d.requireUnlocked();
      const to = checkCosmosAddress(a.to);
      if (to === me) throw invalidInput(l10n('envoi à soi-même', 'send to yourself'));
      const amountStr = String(a.amount ?? '').trim();
      if (!/^\d{1,30}$/.test(amountStr) || BigInt(amountStr) <= 0n) throw invalidInput(l10n('montant en uatom invalide', 'invalid amount in uatom'));
      const memo = a.memo === undefined || a.memo === null ? '' : String(a.memo);
      if ([...memo].length > MAX_MEMO) throw invalidInput(l10n(`mémo : au plus ${MAX_MEMO} caractères`, `memo: at most ${MAX_MEMO} characters`));
      await backend();
      const context = contextNow();
      const amount = BigInt(amountStr);
      checkSend(context.account, amount, 0n);
      const gasLimit = Math.ceil((GAS_USED * 14) / 10);
      const fee = BigInt(Math.ceil((gasLimit * 6) / 1000));
      checkSend(context.account, amount, fee);
      const p: DemoSignDoc = { chainId, accountNumber: context.account.accountNumber, sequence: context.account.sequence, from: me, to, amount: amountStr, fee: fee.toString(), gasLimit, memo, timeoutHeight: state.height + TIMEOUT_BLOCKS };
      const signDoc = encode(p);
      return { signDoc, summary: decode(signDoc).summary, context };
    },
    cosmos_sign_tx: async (a) => {
      d.requireUnlocked();
      const { p, summary } = decode(a.signDoc);
      await backend();
      const context = contextNow();
      if (summary.timeoutHeight <= state.height) throw invalidInput(l10n('transaction Cosmos expirée (timeout_height dépassé) : reconstruis-la', 'Cosmos transaction expired (timeout_height passed): rebuild it'));
      if (summary.accountNumber !== context.account.accountNumber) throw invalidInput(l10n('numéro de compte Cosmos différent de celui du réseau : reconstruis la transaction', 'Cosmos account number differs from the network’s: rebuild the transaction'));
      if (summary.sequence !== context.account.sequence) throw invalidInput(l10n('numéro de séquence périmé : reconstruis la transaction', 'stale sequence number: rebuild the transaction'));
      checkSend(context.account, BigInt(summary.amount), BigInt(summary.fee));
      d.checkPassword(a.password);
      if (!d.confirm(l10n(`Confirmer l'envoi d'ATOM\n${describe(summary, context)}`, `Confirm the ATOM send\n${describe(summary, context)}`))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      if (summary.requiresExtraConfirmation && !d.confirm(l10n('Attention : envoi à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?', 'Warning: send to check\nOnly sign if you know exactly why. Sign anyway?'))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      const signed = { ...p, signature: bytesToHex(sha256(new TextEncoder().encode(`sig:${String(a.signDoc)}`))) };
      const tx = btoa(JSON.stringify(signed));
      return { tx, hash: bytesToHex(sha256(new TextEncoder().encode(tx))).toUpperCase(), summary, context };
    },
    cosmos_broadcast: async (a) => {
      const tx = String(a.tx ?? '').trim();
      let p: DemoSignDoc;
      try {
        p = JSON.parse(atob(tx)) as DemoSignDoc;
      } catch {
        throw invalidInput(l10n('transaction : base64 attendu', 'transaction: base64 expected'));
      }
      if (!p.signature) throw invalidInput(l10n('transaction Cosmos : une signature de 64 octets attendue', 'Cosmos transaction: a 64-byte signature expected'));
      const { signature: _signature, ...unsigned } = p;
      const { summary } = decode(encode(unsigned));
      await backend();
      const ours = state.accounts.get(me);
      if (!ours || summary.sequence !== ours.sequence) throw invalidInput(l10n('transaction Cosmos refusée (code 32) : account sequence mismatch', 'Cosmos transaction rejected (code 32): account sequence mismatch'));
      try {
        checkSend(account(me), BigInt(summary.amount), BigInt(summary.fee));
      } catch {
        throw invalidInput(l10n('transaction Cosmos refusée (code 5) : insufficient funds', 'Cosmos transaction rejected (code 5): insufficient funds'));
      }
      const hash = bytesToHex(sha256(new TextEncoder().encode(tx))).toUpperCase();
      const code = state.failNext ?? 0;
      state.failNext = null;
      // Fee and sequence are consumed whatever the result; the amount only on success.
      ours.balance -= BigInt(summary.fee);
      ours.sequence += 1;
      if (code === 0) {
        const amount = BigInt(summary.amount);
        ours.balance -= amount;
        const dest = state.accounts.get(summary.to);
        if (dest) dest.balance += amount;
        else state.accounts.set(summary.to, { accountNumber: 40_000 + state.accounts.size, sequence: 0, balance: amount });
      }
      state.submitted.set(hash, { at: d.now(), code });
      state.history.unshift({ hash, height: state.height + 1, time: d.now(), from: me, to: summary.to, amount: summary.amount, fee: summary.fee, memo: summary.memo ?? '', success: code === 0 });
      return hash;
    },
    cosmos_tx_status: async (a) => {
      const h = String(a.hash ?? '').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(h)) throw invalidInput(l10n('hash : 64 caractères hexadécimaux', 'hash: 64 hexadecimal characters'));
      await backend();
      const s = state.submitted.get(h.toUpperCase());
      if (!s || d.now() - s.at < INCLUSION_MS) return { included: false, success: false, code: null, height: null, log: '' };
      return { included: true, success: s.code === 0, code: s.code, height: state.height, log: s.code === 0 ? '' : 'out of gas' };
    },
  };

  return { state, handlers };
}
