// SPDX-License-Identifier: GPL-3.0-or-later
// DEMO ONLY — Algorand (`algo_*`, docs/IPC.md §2.11), mirroring apps/desktop/src-tauri/src/

import { base32nopad } from '@scure/base';
import { sha256, sha512_256 } from '@noble/hashes/sha2';
import { algoAddressOf } from './algo';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  IpcError,
  type AlgoAccountInfo,
  type AlgoBackendInfo,
  type AlgoContext,
  type AlgoHistoryEntry,
  type AlgoTxSummary,
  type AlgoWarning,
  type Commands,
  type Network,
  type Settings,
} from './ipc';
import { decimalMark, l10n, sentence } from './i18n';
import type { DemoTor } from './mock-tor';

export const ALGO_MIN_BALANCE = 100_000n;
const FEE = 1_000n;
/** Rust: lv = fv + 200 rounds (≈ 9 min). */
const LV_OFFSET = 200;
const MAX_NOTE = 1024;
/** Demo: a submitted payment is confirmed after this long. */
const CONFIRM_MS = 4_000;
const GENESIS: Record<Network, { id: string; hash: string }> = {
  mainnet: { id: 'mainnet-v1.0', hash: 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' },
  testnet: { id: 'testnet-v1.0', hash: 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=' },
};

export { algoAddressOf };

/** Demo address of Algorand account `account` (a label hash, not a derived key: see above). */
export function demoAlgoAddress(account: number): string {
  return algoAddressOf(sha256(new TextEncoder().encode(`kyro-demo-algorand-account-${account}`)));
}

const invalidInput = (m: string) => new IpcError('INVALID_INPUT', sentence(m));

/** wallet-core `algo_address_bytes`: 58 upper-case base32 characters, checksum verified. */
export function checkAlgoAddress(a: unknown): string {
  const s = String(a ?? '').trim();
  let raw: Uint8Array;
  try {
    if (s.length !== 58) throw new Error('length');
    raw = base32nopad.decode(s);
  } catch {
    throw invalidInput(l10n('adresse Algorand invalide', 'invalid Algorand address'));
  }
  if (raw.length !== 36) throw invalidInput(l10n('adresse Algorand invalide', 'invalid Algorand address'));
  const sum = sha512_256(raw.slice(0, 32)).slice(28);
  if (!raw.slice(32).every((b, i) => b === sum[i])) throw invalidInput(l10n('adresse Algorand invalide (somme de contrôle)', 'invalid Algorand address (checksum)'));
  return s;
}

const algoText = (micro: bigint | string) => {
  const v = BigInt(micro);
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${v / 1_000_000n}${frac ? `${decimalMark()}${frac}` : ''} ALGO`;
};

interface DemoAlgoAccount {
  balance: bigint;
  assets: number;
  authAddr: string | null;
}

/** Demo payment (hex JSON). `close` / `rekey` exist so the refusals can be tested. */
interface DemoPayment {
  sender: string;
  receiver: string;
  amount: string;
  fee: string;
  firstValid: number;
  lastValid: number;
  genesisId: string;
  genesisHash: string;
  note: string | null;
  close?: string;
  rekey?: string;
  sig?: string;
}

export interface DemoAlgoDeps {
  network: Network;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
  now: () => number;
}

export interface DemoAlgoState {
  me: string;
  friend: string;
  /** An account that never received ALGO (needs ≥ 0.1 ALGO). */
  empty: string;
  accounts: Map<string, DemoAlgoAccount>;
  history: AlgoHistoryEntry[];
  submitted: Map<string, number>;
  round: number;
}

export function createDemoAlgo(d: DemoAlgoDeps) {
  const netKey = d.network === 'mainnet' ? 'mainnet' : 'testnet';
  const me = demoAlgoAddress(0);
  const label = (l: string) => algoAddressOf(sha256(new TextEncoder().encode(l)));
  const friend = label('kyro-demo-algo-friend');
  const empty = label('kyro-demo-algo-empty');
  const t0 = d.now();
  const round0 = d.network === 'mainnet' ? 66_529_512 : 68_824_675;
  const state: DemoAlgoState = {
    me,
    friend,
    empty,
    accounts: new Map([
      // One asset opted in: minimum balance 0.2 ALGO.
      [me, { balance: 42_500_000n, assets: 1, authAddr: null }],
      [friend, { balance: 120_000_000n, assets: 0, authAddr: null }],
    ]),
    history: [
      { id: base32nopad.encode(sha512_256(new TextEncoder().encode('algo-in-1'))), type: 'pay', from: friend, to: me, amount: '42500000', fee: '1000', closeTo: null, closeAmount: null, round: round0 - 30_000, time: t0 - 2 * 86_400_000, note: 'Merci pour le dîner' },
    ],
    submitted: new Map(),
    round: round0,
  };

  const torOn = () => d.settings().tor.enabled;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const backend = async () => {
    if (torOn()) await d.tor.waitReady();
    await wait(50 + Math.random() * 120);
    state.round = round0 + Math.floor((d.now() - t0) / 2800);
  };

  const account = (address: string): AlgoAccountInfo => {
    const a = state.accounts.get(address);
    const balance = a?.balance ?? 0n;
    const min = ALGO_MIN_BALANCE * BigInt(1 + (a?.assets ?? 0));
    return {
      address,
      exists: balance > 0n,
      balance: balance.toString(),
      minBalance: min.toString(),
      spendable: (balance > min ? balance - min : 0n).toString(),
      assets: a?.assets ?? 0,
      authAddr: a?.authAddr ?? null,
      round: state.round,
    };
  };

  const checkPayment = (ours: AlgoAccountInfo, dest: AlgoAccountInfo, amount: bigint, fee: bigint) => {
    if (ours.authAddr) throw invalidInput(l10n(`ce compte Algorand a été « rekeyé » vers ${ours.authAddr} : sa clé de signature n'est plus celle de ce portefeuille, Kyro ne peut pas signer pour lui`, `this Algorand account was “rekeyed” to ${ours.authAddr}: its signing key is no longer this wallet's, Kyro cannot sign for it`));
    if (!ours.exists) throw invalidInput(l10n("ton compte Algorand n'est pas encore activé (aucun ALGO reçu)", 'your Algorand account is not activated yet (no ALGO received)'));
    const spendable = BigInt(ours.spendable);
    if (amount + fee > spendable) {
      throw invalidInput(l10n(`solde disponible insuffisant : ${algoText(spendable)} disponibles (solde − solde minimum de ${algoText(ours.minBalance)}), il en faut ${algoText(amount + fee)}`, `insufficient available balance: ${algoText(spendable)} available (balance − minimum balance of ${algoText(ours.minBalance)}), ${algoText(amount + fee)} needed`));
    }
    const db = BigInt(dest.balance);
    const dm = BigInt(dest.minBalance);
    if (db + amount < dm) {
      throw invalidInput(
        dest.exists
          ? l10n(`ce destinataire resterait sous son solde minimum (${algoText(dm)}) : envoie au moins ${algoText(dm - db)}`, `this recipient would stay below its minimum balance (${algoText(dm)}): send at least ${algoText(dm - db)}`)
          : l10n(`ce compte n'existe pas encore : il faut lui envoyer au moins ${algoText(dm)} (solde minimum), sinon le paiement est rejeté`, `this account does not exist yet: you must send it at least ${algoText(dm)} (minimum balance), otherwise the payment is rejected`),
      );
    }
  };

  const encode = (p: DemoPayment) => bytesToHex(new TextEncoder().encode(JSON.stringify(p)));
  const txidOf = (p: DemoPayment) => base32nopad.encode(sha512_256(new TextEncoder().encode(`TX${JSON.stringify({ ...p, sig: undefined })}`)));

  const decode = (blob: unknown): { p: DemoPayment; summary: AlgoTxSummary } => {
    let p: DemoPayment;
    try {
      p = JSON.parse(new TextDecoder().decode(hexToBytes(String(blob ?? '').trim().toLowerCase()))) as DemoPayment;
    } catch {
      throw invalidInput(l10n('le blob n’est pas en hexadécimal', 'the blob is not hexadecimal'));
    }
    const bad = (m: string) => invalidInput(l10n(`transaction Algorand : ${m}`, `Algorand transaction: ${m}`));
    if (p.close !== undefined) throw bad(l10n('close-remainder-to refusé : il enverrait TOUT le solde restant à une autre adresse et fermerait le compte', 'close-remainder-to refused: it would send ALL the remaining balance to another address and close the account'));
    if (p.rekey !== undefined) throw bad(l10n('rekey refusé : il donnerait le contrôle de ce compte à une autre clé', 'rekey refused: it would give control of this account to another key'));
    if (p.sender !== me) throw bad(l10n("l'expéditeur n'est pas l'adresse de ce portefeuille", 'the sender is not this wallet\'s address'));
    const g = GENESIS[d.network];
    if (p.genesisId !== g.id || p.genesisHash !== g.hash) throw bad(l10n(`réseau inattendu (« ${p.genesisId} ») : ce portefeuille est sur ${g.id}`, `unexpected network (“${p.genesisId}”): this wallet is on ${g.id}`));
    checkAlgoAddress(p.receiver);
    if (p.receiver === me) throw bad(l10n('paiement à soi-même', 'payment to yourself'));
    if (BigInt(p.amount) <= 0n) throw bad(l10n('montant nul', 'zero amount'));
    const noteBytes = p.note === null ? 0 : new TextEncoder().encode(p.note).length;
    if (noteBytes > MAX_NOTE) throw bad(l10n('note de plus de 1024 octets', 'note over 1024 bytes'));
    const warnings: AlgoWarning[] = [];
    if (noteBytes > 0) warnings.push({ kind: 'note' });
    if (BigInt(p.fee) > 10_000n) warnings.push({ kind: 'highFee' });
    const summary: AlgoTxSummary = {
      sender: p.sender,
      receiver: p.receiver,
      amount: p.amount,
      fee: p.fee,
      firstValid: p.firstValid,
      lastValid: p.lastValid,
      genesisId: p.genesisId,
      genesisHash: p.genesisHash,
      noteLen: noteBytes,
      noteHex: p.note === null ? null : bytesToHex(new TextEncoder().encode(p.note)),
      noteText: p.note,
      txid: txidOf(p),
      warnings,
      requiresExtraConfirmation: warnings.length > 0,
    };
    return { p, summary };
  };

  const contextFor = (to: string): AlgoContext => ({ account: account(me), destination: account(to), round: state.round });

  const describe = (s: AlgoTxSummary, c: AlgoContext): string => {
    let out = l10n(`Envoi Algorand${d.network === 'testnet' ? ' (testnet)' : ''}\n\nÀ : ${s.receiver}\nMontant : ${algoText(s.amount)} (${s.amount} µALGO)\n`, `Algorand send${d.network === 'testnet' ? ' (testnet)' : ''}\n\nTo: ${s.receiver}\nAmount: ${algoText(s.amount)} (${s.amount} µALGO)\n`);
    if (!c.destination.exists) out += l10n(`\nCe compte n'existe pas encore : ce paiement le crée (au moins ${algoText(c.destination.minBalance)} doivent y rester, solde minimum).\n`, `\nThis account does not exist yet: this payment creates it (at least ${algoText(c.destination.minBalance)} must stay on it, minimum balance).\n`);
    out += l10n(`\nFrais : ${algoText(s.fee)} (${s.fee} µALGO)\nSolde : ${algoText(c.account.balance)} · solde minimum bloqué : ${algoText(c.account.minBalance)} · disponible : ${algoText(c.account.spendable)}\n`, `\nFee: ${algoText(s.fee)} (${s.fee} µALGO)\nBalance: ${algoText(c.account.balance)} · locked minimum balance: ${algoText(c.account.minBalance)} · available: ${algoText(c.account.spendable)}\n`);
    out += l10n(`Réseau : ${s.genesisId} (genesis ${s.genesisHash})\nValable des rounds ${s.firstValid} à ${s.lastValid}\n`, `Network: ${s.genesisId} (genesis ${s.genesisHash})\nValid from round ${s.firstValid} to ${s.lastValid}\n`);
    if (s.noteText !== null) out += l10n(`Note (texte libre, publique à jamais) : « ${s.noteText} »\n`, `Note (free text, public forever): “${s.noteText}”\n`);
    else if (s.noteLen > 0) out += l10n(`Note binaire (${s.noteLen} octets, publique à jamais) : ${s.noteHex ?? ''}\n`, `Binary note (${s.noteLen} bytes, public forever): ${s.noteHex ?? ''}\n`);
    out += l10n(`Identifiant : ${s.txid}\n`, `ID: ${s.txid}\n`);
    return out;
  };

  const handlers: Record<Extract<keyof Commands, `algo_${string}`>, (a: Record<string, unknown>) => unknown> = {
    algo_backend_info: (): AlgoBackendInfo => ({
      kind: 'default',
      network: netKey,
      label: `${netKey}-api.algonode.cloud`,
      indexer: `${netKey}-idx.algonode.cloud`,
      tor: torOn(),
    }),
    algo_address: (a) => {
      d.requireUnlocked();
      const account = a.account === undefined ? 0 : Number(a.account);
      if (!Number.isInteger(account) || account < 0 || account > 100) throw invalidInput(l10n('numéro de compte : au plus 100', 'account number: at most 100'));
      return demoAlgoAddress(account);
    },
    algo_account: async (a) => {
      const addr = checkAlgoAddress(a.address);
      await backend();
      return account(addr);
    },
    algo_txs: async (a) => {
      const addr = checkAlgoAddress(a.address);
      await backend();
      return state.history.filter((t) => t.from === addr || t.to === addr).slice(0, 50);
    },
    algo_build_tx: async (a) => {
      d.requireUnlocked();
      const to = checkAlgoAddress(a.to);
      const amount = String(a.amount ?? '').trim();
      if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw invalidInput(l10n('montant en µALGO invalide', 'invalid µALGO amount'));
      const note = a.note === undefined || a.note === null || a.note === '' ? null : String(a.note);
      if (note !== null && new TextEncoder().encode(note).length > MAX_NOTE) throw invalidInput(l10n('note : au plus 1024 octets', 'note: 1024 bytes at most'));
      await backend();
      const context = contextFor(to);
      checkPayment(context.account, context.destination, BigInt(amount), FEE);
      const g = GENESIS[d.network];
      const p: DemoPayment = { sender: me, receiver: to, amount, fee: FEE.toString(), firstValid: state.round, lastValid: state.round + LV_OFFSET, genesisId: g.id, genesisHash: g.hash, note };
      const blob = encode(p);
      return { blob, summary: decode(blob).summary, context };
    },
    algo_sign_tx: async (a) => {
      d.requireUnlocked();
      const { p, summary } = decode(a.blob);
      await backend();
      const context = contextFor(summary.receiver);
      if (summary.lastValid <= state.round) throw invalidInput(l10n('paiement Algorand expiré (dernier round de validité dépassé) : reconstruis-le', 'Algorand payment expired (last valid round passed): rebuild it'));
      checkPayment(context.account, context.destination, BigInt(summary.amount), BigInt(summary.fee));
      d.checkPassword(a.password);
      if (!d.confirm(l10n(`Confirmer le paiement Algorand\n${describe(summary, context)}`, `Confirm the Algorand payment\n${describe(summary, context)}`))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      if (summary.requiresExtraConfirmation && !d.confirm(l10n('Attention : paiement à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?', 'Warning: payment to check\nOnly sign if you know exactly why. Sign anyway?'))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      const signed = encode({ ...p, sig: bytesToHex(sha256(new TextEncoder().encode(`sig:${String(a.blob)}`))) });
      return { blob: signed, txid: summary.txid, summary, context };
    },
    algo_broadcast: async (a) => {
      const { p, summary } = decode(a.blob);
      if (!p.sig) throw invalidInput(l10n('transaction Algorand : non signée', 'Algorand transaction: not signed'));
      await backend();
      if (summary.lastValid <= state.round) throw invalidInput(l10n('paiement Algorand refusé : txn dead (round de validité dépassé)', 'Algorand payment rejected: txn dead (valid round passed)'));
      if (state.submitted.has(summary.txid)) throw invalidInput(l10n('paiement Algorand refusé : transaction already in ledger', 'Algorand payment rejected: transaction already in ledger'));
      const ctx = contextFor(summary.receiver);
      try {
        checkPayment(ctx.account, ctx.destination, BigInt(summary.amount), BigInt(summary.fee));
      } catch {
        throw invalidInput(l10n('paiement Algorand refusé : overspend (solde insuffisant)', 'Algorand payment rejected: overspend (insufficient balance)'));
      }
      const ours = state.accounts.get(me);
      if (!ours) throw invalidInput(l10n('paiement Algorand refusé : overspend (solde insuffisant)', 'Algorand payment rejected: overspend (insufficient balance)'));
      ours.balance -= BigInt(summary.fee) + BigInt(summary.amount);
      const dest = state.accounts.get(summary.receiver);
      if (dest) dest.balance += BigInt(summary.amount);
      else state.accounts.set(summary.receiver, { balance: BigInt(summary.amount), assets: 0, authAddr: null });
      state.submitted.set(summary.txid, d.now());
      state.history.unshift({ id: summary.txid, type: 'pay', from: me, to: summary.receiver, amount: summary.amount, fee: summary.fee, closeTo: null, closeAmount: null, round: state.round + 1, time: d.now(), note: summary.noteText });
      return summary.txid;
    },
    algo_tx_status: async (a) => {
      const t = String(a.txid ?? '').trim();
      if (!/^[A-Z2-7]{52}$/.test(t)) throw invalidInput(l10n('identifiant de transaction Algorand : 52 caractères base32', 'Algorand transaction ID: 52 base32 characters'));
      await backend();
      const at = state.submitted.get(t);
      if (at === undefined) return { confirmed: false, round: null, error: null };
      return d.now() - at >= CONFIRM_MS ? { confirmed: true, round: state.round, error: null } : { confirmed: false, round: null, error: null };
    },
    // Tokens (ASA): not simulated in the demo (no holdings, opt-in and sends refused).
    algo_asset_holdings: async (a) => {
      checkAlgoAddress(a.address);
      await backend();
      return [];
    },
    algo_build_optin_tx: () => Promise.reject(invalidInput(l10n('Démo : jetons Algorand non simulés', 'Demo: Algorand tokens are not simulated'))),
    algo_build_asset_tx: () => Promise.reject(invalidInput(l10n('Démo : jetons Algorand non simulés', 'Demo: Algorand tokens are not simulated'))),
  };

  return { state, handlers };
}
