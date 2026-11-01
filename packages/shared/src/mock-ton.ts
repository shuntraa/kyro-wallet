// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — TON (`ton_*`, docs/IPC.md §2.11), mirroring apps/desktop/src-tauri/src/
// commands_ton.rs and ton_backend.rs. Addresses are well-formed user-friendly addresses (CRC16
// checked) of DEMO account ids (sha256 of a label), NOT the real v4R2 address of a key; the
// transfer "BOC" is a demo encoding (base64 JSON, not a bag of cells) and the signature is fake.
// The rules are Rust's:
// - user-friendly addresses only (raw `0:…` refused), testnet-flagged ones refused on mainnet,
//   masterchain refused; frozen recipient refused;
// - bounce = the address's flag, off when the recipient is not an active contract;
// - our wallet: `uninit` with a balance → first transfer deploys it (seqno 0); empty or frozen →
//   refused; amount + estimated fee ≥ balance → refused; comment ≤ 123 bytes;
// - sign re-reads everything live, refuses an expired message or a stale seqno;
// - a sent transfer is processed a few seconds later (`ton_tx_status`).

import { sha256 } from '@noble/hashes/sha2';
import { base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils';
import {
  IpcError,
  type Commands,
  type Network,
  type Settings,
  type TonAccountInfo,
  type TonBackendInfo,
  type TonContext,
  type TonHistoryEntry,
  type TonStatus,
  type TonTxStatus,
  type TonTxSummary,
  type TonWarning,
} from './ipc';
import { parseTonAddress, tonAddressProblem, tonFriendly } from './ton-address';
import { l10n } from './i18n';
import type { DemoTor } from './mock-tor';

/** Demo fee of a transfer (nanotons), and of a first transfer that deploys the wallet. */
export const TON_DEMO_FEE = 3_400_000n;
export const TON_DEMO_DEPLOY_FEE = 9_100_000n;
const VALID_FOR_SECS = 600;
const MAX_COMMENT_BYTES = 123;
/** Demo: a sent transfer is processed after this long. */
const PROCESS_MS = 5_000;

const hashOfLabel = (label: string) => bytesToHex(sha256(new TextEncoder().encode(label)));

/** Demo address of TON account `account` (non-bounceable, testnet flag on testnet). */
export function demoTonAddress(account: number, network: Network): string {
  return tonFriendly(0, hashOfLabel(`kyro-demo-ton-${network}-${account}`), false, network === 'testnet');
}

const invalidInput = (m: string) => new IpcError('INVALID_INPUT', l10n(`Entrée invalide : ${m}`, `Invalid input: ${m}`));
const tonText = (nano: bigint | string) => {
  const v = BigInt(nano);
  const frac = (v % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${v / 1_000_000_000n}${frac ? `,${frac}` : ''} TON`;
};

interface DemoTonAccount {
  status: TonStatus;
  balance: bigint;
  seqno: number;
}

/** Demo transfer (base64 JSON). */
interface DemoTransfer {
  wallet: string;
  destHash: string;
  bounce: boolean;
  amount: string;
  sendAll: boolean;
  comment: string | null;
  seqno: number;
  validUntil: number;
  deploys: boolean;
  signature?: string;
}

export interface DemoTonDeps {
  network: Network;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
  now: () => number;
}

export interface DemoTonState {
  me: string;
  /** An exchange's deposit wallet (active, bounceable form): needs a comment. */
  exchange: string;
  /** A friend's wallet (active). */
  friend: string;
  /** A wallet that never received anything (uninit). */
  fresh: string;
  /** Account hash (hex) → state. */
  accounts: Map<string, DemoTonAccount>;
  history: TonHistoryEntry[];
  /** Normalized hash → send time and result. */
  sent: Map<string, { at: number; success: boolean; txHash: string }>;
}

export function createDemoTon(d: DemoTonDeps) {
  const netKey = d.network === 'mainnet' ? 'mainnet' : 'testnet';
  const testnet = d.network === 'testnet';
  const me = demoTonAddress(0, d.network);
  const meHash = parseTonAddress(me)!.hash;
  const exchangeHash = hashOfLabel('kyro-demo-ton-exchange');
  const friendHash = hashOfLabel('kyro-demo-ton-friend');
  const freshHash = hashOfLabel('kyro-demo-ton-fresh');
  const t0 = d.now();
  const state: DemoTonState = {
    me,
    exchange: tonFriendly(0, exchangeHash, true, false),
    friend: tonFriendly(0, friendHash, false, testnet),
    fresh: tonFriendly(0, freshHash, false, testnet),
    accounts: new Map([
      [meHash, { status: 'active', balance: 42_750_000_000n, seqno: 12 }],
      [exchangeHash, { status: 'active', balance: 980_000_000_000_000n, seqno: 90_211 }],
      [friendHash, { status: 'active', balance: 3_100_000_000n, seqno: 4 }],
    ]),
    history: [
      { hash: hashOfLabel('ton-in-2'), time: t0 - 86_400_000, direction: 'in', counterparty: tonFriendly(0, exchangeHash, true, testnet), amount: '25000000000', fee: null, comment: null, bounced: false, success: true },
      { hash: hashOfLabel('ton-out-1'), time: t0 - 2 * 86_400_000, direction: 'out', counterparty: tonFriendly(0, friendHash, false, testnet), amount: '1500000000', fee: '3412345', comment: 'Merci pour le dîner', bounced: false, success: true },
      { hash: hashOfLabel('ton-in-1'), time: t0 - 3 * 86_400_000, direction: 'in', counterparty: tonFriendly(0, friendHash, false, testnet), amount: '19250000000', fee: null, comment: null, bounced: false, success: true },
    ],
    sent: new Map(),
  };

  const torOn = () => d.settings().tor.enabled;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const nowSecs = () => Math.floor(d.now() / 1000);

  /** Gate of every read: Tor (no fallback), the pacing of TON Center's public tier. */
  const backend = async () => {
    if (torOn()) await d.tor.waitReady();
    await wait(80 + Math.random() * 150);
  };

  /** commands_ton.rs parse_user_address. */
  const userAddress = (a: unknown) => {
    const s = String(a ?? '').trim();
    const problem = tonAddressProblem(s);
    if (problem) throw invalidInput(problem);
    const p = parseTonAddress(s)!;
    if (p.testnet && d.network === 'mainnet') throw invalidInput(l10n('adresse TON de testnet (kQ… / 0Q…) : refusée sur mainnet', 'testnet TON address (kQ… / 0Q…): refused on mainnet'));
    if (p.workchain !== 0) throw invalidInput(l10n('adresse de la masterchain (-1) : seuls les comptes de la basechain (0) sont pris en charge', 'masterchain address (-1): only basechain (0) accounts are supported'));
    return p;
  };

  const info = (hash: string): TonAccountInfo => {
    const a = state.accounts.get(hash);
    const status: TonStatus = a?.status ?? 'uninit';
    return {
      address: tonFriendly(0, hash, false, testnet),
      raw: `0:${hash}`,
      status,
      balance: (a?.balance ?? 0n).toString(),
      seqno: status === 'active' ? (a?.seqno ?? 0) : null,
      walletType: status === 'active' ? 'wallet v4 r2' : null,
    };
  };

  /** ton_backend::check_transfer. */
  const checkTransfer = (ours: TonAccountInfo, amount: bigint | null, fee: bigint) => {
    const balance = BigInt(ours.balance);
    if (ours.status === 'frozen') throw invalidInput(l10n('ton portefeuille TON est gelé (frais de stockage impayés) : il ne peut rien envoyer', 'your TON wallet is frozen (unpaid storage fees): it cannot send anything'));
    if (ours.status === 'nonexist' || (ours.status === 'uninit' && balance === 0n)) throw invalidInput(l10n("ton portefeuille TON n'a encore rien reçu : il ne peut rien envoyer", 'your TON wallet has not received anything yet: it cannot send anything'));
    const need = (amount ?? 0n) + fee;
    if (need >= balance) {
      throw invalidInput(l10n(`solde TON insuffisant : ${tonText(balance).replace(' TON', '')} TON, il en faut plus de ${tonText(need).replace(' TON', '')} (montant + frais estimés${ours.status === 'uninit' ? ', dont le déploiement du portefeuille' : ''})`, `insufficient TON balance: ${tonText(balance).replace(' TON', '')} TON, more than ${tonText(need).replace(' TON', '')} needed (amount + estimated fee${ours.status === 'uninit' ? ', including the wallet deployment' : ''})`));
    }
  };

  const encode = (t: DemoTransfer) => base64.encode(new TextEncoder().encode(JSON.stringify(t)));
  const decode = (boc: unknown): DemoTransfer => {
    let t: DemoTransfer;
    try {
      t = JSON.parse(new TextDecoder().decode(base64.decode(String(boc ?? '').trim()))) as DemoTransfer;
    } catch {
      throw invalidInput(l10n('BOC TON invalide', 'invalid TON BOC'));
    }
    if (t.wallet !== me) throw invalidInput(l10n("ce message n'est pas adressé à ton portefeuille TON", 'this message is not addressed to your TON wallet'));
    return t;
  };

  const summaryOf = (t: DemoTransfer): TonTxSummary => {
    const warnings: TonWarning[] = [];
    // eslint-disable-next-line no-control-regex
    const clean = t.comment?.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/[​-‏‪-‮⁠-⁯﻿]/g, '') ?? null;
    if (t.comment !== null && clean !== t.comment) warnings.push({ kind: 'unusualText' });
    return {
      wallet: me,
      destination: tonFriendly(0, t.destHash, t.bounce, testnet),
      destinationOther: tonFriendly(0, t.destHash, !t.bounce, testnet),
      destinationRaw: `0:${t.destHash}`,
      amount: t.amount,
      sendAll: t.sendAll,
      bounce: t.bounce,
      comment: clean,
      seqno: t.seqno,
      validUntil: t.validUntil,
      deploysWallet: t.deploys,
      walletId: testnet ? 0x4b59524f : 698983191,
      warnings,
      requiresExtraConfirmation: warnings.length > 0,
    };
  };

  /** commands_ton.rs describe_ton: the comment gets its own framed block. */
  const describe = (s: TonTxSummary, c: TonContext): string => {
    const line = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    let out = l10n(`Envoi TON${testnet ? ' (testnet)' : ''}\n\nÀ : ${s.destination}\n(même compte que ${s.destinationOther} : seul l'indicateur de rebond diffère)\n${line}\n`, `TON send${testnet ? ' (testnet)' : ''}\n\nTo: ${s.destination}\n(same account as ${s.destinationOther}: only the bounce flag differs)\n${line}\n`);
    out += s.comment !== null ? l10n(`COMMENTAIRE : « ${s.comment} »\n`, `COMMENT: “${s.comment}”\n`) : l10n("AUCUN COMMENTAIRE\n(une plateforme d'échange en exige souvent un, appelé aussi mémo ou tag : sans lui, les fonds peuvent être perdus)\n", 'NO COMMENT\n(an exchange often requires one, also called memo or tag: without it, the funds may be lost)\n');
    out += `${line}\n`;
    out += s.sendAll ? l10n(`Montant : TOUT LE SOLDE, ≈ ${tonText(c.account.balance)} (solde moins les frais) — ton portefeuille restera à 0\n`, `Amount: THE WHOLE BALANCE, ≈ ${tonText(c.account.balance)} (balance minus fees) — your wallet will be left at 0\n`) : l10n(`Montant : ${tonText(s.amount)} (${s.amount} nanotons)\n`, `Amount: ${tonText(s.amount)} (${s.amount} nanotons)\n`);
    out += s.bounce ? l10n('Rebond : oui (si le destinataire échoue, les fonds reviennent, moins les frais)\n', 'Bounce: yes (if the recipient fails, the funds come back, minus fees)\n') : c.destination.status === 'active' ? l10n("Rebond : non (adresse non rebondissante UQ… : les fonds restent chez le destinataire quoi qu'il arrive)\n", 'Bounce: no (non-bounceable UQ… address: the funds stay with the recipient whatever happens)\n') : l10n("Rebond : non — ce compte n'est pas encore actif (jamais utilisé) : les fonds y arrivent quand même et y restent\n", 'Bounce: no — this account is not active yet (never used): the funds still arrive there and stay\n');
    out += l10n(`\nFrais estimés : ≈ ${tonText(c.fee)} (en plus du montant, prélevés sur ton solde)\nSolde : ${tonText(c.account.balance)}\n`, `\nEstimated fee: ≈ ${tonText(c.fee)} (on top of the amount, taken from your balance)\nBalance: ${tonText(c.account.balance)}\n`);
    if (s.deploysWallet) out += l10n('Premier envoi : il déploie aussi ton portefeuille (contrat standard v4R2).\n', 'First send: it also deploys your wallet (standard v4R2 contract).\n');
    out += l10n(`Valable encore ≈ ${Math.ceil(Math.max(0, s.validUntil - nowSecs()) / 60)} min, seqno ${s.seqno}\n`, `Still valid ≈ ${Math.ceil(Math.max(0, s.validUntil - nowSecs()) / 60)} min, seqno ${s.seqno}\n`);
    return out;
  };

  const feeFor = (ours: TonAccountInfo) => (ours.status === 'uninit' ? TON_DEMO_DEPLOY_FEE : TON_DEMO_FEE);

  const handlers: Record<Extract<keyof Commands, `ton_${string}`>, (a: Record<string, unknown>) => unknown> = {
    ton_backend_info: (): TonBackendInfo => ({ network: netKey, label: testnet ? 'testnet.toncenter.com' : 'toncenter.com', tor: torOn() }),
    ton_address: (a) => {
      d.requireUnlocked();
      const account = a.account === undefined ? 0 : Number(a.account);
      if (!Number.isInteger(account) || account < 0 || account > 100) throw invalidInput(l10n('numéro de compte : au plus 100', 'account number: at most 100'));
      return demoTonAddress(account, d.network);
    },
    ton_account: async (a) => {
      const p = userAddress(a.address);
      await backend();
      return info(p.hash);
    },
    ton_txs: async (a) => {
      const p = userAddress(a.address);
      await backend();
      return p.hash === meHash ? state.history.slice(0, 50) : [];
    },
    ton_build_tx: async (a) => {
      d.requireUnlocked();
      const dest = userAddress(a.to);
      const sendAll = a.sendAll === true;
      const amountStr = String(a.amount ?? '').trim();
      if (!sendAll && (!/^\d+$/.test(amountStr) || BigInt(amountStr) <= 0n)) throw invalidInput(l10n('montant en nanotons invalide', 'invalid amount in nanotons'));
      const comment = typeof a.comment === 'string' && a.comment !== '' ? a.comment : null;
      if (comment !== null && new TextEncoder().encode(comment).length > MAX_COMMENT_BYTES) {
        throw invalidInput(l10n(`commentaire trop long (${new TextEncoder().encode(comment).length} octets, ${MAX_COMMENT_BYTES} au plus)`, `comment too long (${new TextEncoder().encode(comment).length} bytes, ${MAX_COMMENT_BYTES} at most)`));
      }
      await backend();
      const account = info(meHash);
      const destination = info(dest.hash);
      if (destination.status === 'frozen') throw invalidInput(l10n('le compte destinataire est gelé (frais de stockage impayés) : envoi refusé', 'the recipient account is frozen (unpaid storage fees): send refused'));
      const fee = feeFor(account);
      checkTransfer(account, sendAll ? null : BigInt(amountStr), fee);
      const t: DemoTransfer = {
        wallet: me,
        destHash: dest.hash,
        bounce: dest.bounceable && destination.status === 'active',
        amount: sendAll ? '0' : amountStr,
        sendAll,
        comment,
        seqno: account.status === 'active' ? (account.seqno ?? 0) : 0,
        validUntil: nowSecs() + VALID_FOR_SECS,
        deploys: account.status === 'uninit',
      };
      const boc = encode(t);
      return { boc, summary: summaryOf(t), context: { account, destination, fee: fee.toString() } };
    },
    ton_sign_tx: async (a) => {
      d.requireUnlocked();
      const t = decode(a.boc);
      if (t.signature) throw invalidInput(l10n('ce transfert TON est déjà signé', 'this TON transfer is already signed'));
      const summary = summaryOf(t);
      if (t.validUntil <= nowSecs() + 15) throw invalidInput(l10n('transfert TON expiré (valable 10 min après sa préparation) : reconstruis-le', 'TON transfer expired (valid 10 min after it was prepared): rebuild it'));
      await backend();
      const account = info(meHash);
      const destination = info(t.destHash);
      const fresh = account.status === 'uninit' ? t.deploys && t.seqno === 0 : account.status === 'active' && !t.deploys && account.seqno === t.seqno;
      if (!fresh) throw invalidInput(l10n('numéro de séquence (seqno) ou état du portefeuille périmé : reconstruis le transfert', 'stale sequence number (seqno) or wallet state: rebuild the transfer'));
      const fee = feeFor(account);
      checkTransfer(account, t.sendAll ? null : BigInt(t.amount), fee);
      const context: TonContext = { account, destination, fee: fee.toString() };
      d.checkPassword(a.password);
      if (!d.confirm(l10n(`Confirmer l'envoi TON\n${describe(summary, context)}`, `Confirm the TON send\n${describe(summary, context)}`))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      if (summary.requiresExtraConfirmation && !d.confirm(l10n('Attention : transfert à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?', 'Warning: transfer to check\nOnly sign if you know exactly why. Sign anyway?'))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      const signed = encode({ ...t, signature: hashOfLabel(`sig:${String(a.boc)}`) });
      return { boc: signed, hash: hashOfLabel(`msg:${signed}`), normalizedHash: hashOfLabel(`norm:${signed}`), summary, context };
    },
    ton_broadcast: async (a) => {
      const t = decode(a.boc);
      if (!t.signature) throw invalidInput(l10n('signature TON invalide', 'invalid TON signature'));
      if (t.validUntil <= nowSecs()) throw invalidInput(l10n('transfert TON expiré : reconstruis-le', 'TON transfer expired: rebuild it'));
      await backend();
      const ours = state.accounts.get(meHash);
      const seqno = ours?.status === 'active' ? ours.seqno : 0;
      if (!ours || t.seqno !== seqno) throw invalidInput(l10n('transfert TON refusé par le nœud : seqno inattendu', 'TON transfer rejected by the node: unexpected seqno'));
      const fee = t.deploys ? TON_DEMO_DEPLOY_FEE : TON_DEMO_FEE;
      const amount = t.sendAll ? ours.balance - fee : BigInt(t.amount);
      const success = amount > 0n && amount + fee <= ours.balance;
      ours.balance -= success ? amount + fee : fee;
      ours.status = 'active';
      ours.seqno = seqno + 1;
      if (success) {
        const dest = state.accounts.get(t.destHash);
        if (dest) dest.balance += amount;
        else state.accounts.set(t.destHash, { status: 'uninit', balance: amount, seqno: 0 });
      }
      const norm = hashOfLabel(`norm:${String(a.boc).trim()}`);
      const txHash = hashOfLabel(`tx:${norm}`);
      state.sent.set(norm, { at: d.now(), success, txHash });
      state.history.unshift({ hash: txHash, time: d.now(), direction: 'out', counterparty: tonFriendly(0, t.destHash, t.bounce, testnet), amount: success ? amount.toString() : '0', fee: fee.toString(), comment: t.comment, bounced: false, success });
      return norm;
    },
    ton_build_jetton_tx: () => Promise.reject(new Error(l10n('Démo : envoi de jetons TON non simulé', 'Demo: TON token sends are not simulated'))),
    ton_jetton_balances: () => Promise.resolve([]),
    ton_jetton_txs: () => Promise.resolve([]),
    ton_tx_status: async (a): Promise<TonTxStatus> => {
      const h = String(a.hash ?? '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(h)) throw invalidInput(l10n('hash : 64 caractères hexadécimaux', 'hash: 64 hexadecimal characters'));
      await backend();
      const s = state.sent.get(h);
      if (!s || d.now() - s.at < PROCESS_MS) return { found: false, success: false, txHash: null };
      return { found: true, success: s.success, txHash: s.txHash };
    },
  };

  return { state, handlers };
}
