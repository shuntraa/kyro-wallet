// SPDX-License-Identifier: GPL-3.0-or-later
// DEMO ONLY — NEAR Protocol (`near_*`, docs/IPC.md §2.11), mirroring apps/desktop/src-tauri/src/

import { sha256 } from '@noble/hashes/sha2';
import { base58 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  IpcError,
  type Commands,
  type Network,
  type NearAccountInfo,
  type NearBackendInfo,
  type NearContext,
  type NearHistoryEntry,
  type NearTxOutcome,
  type NearTxSummary,
  type NearWarning,
  type Settings,
} from './ipc';
import { nearAccountKind } from './near';
import { decimalMark, l10n, sentence } from './i18n';
import type { DemoTor } from './mock-tor';

const YOCTO = 10n ** 24n;
const GAS_PRICE = 100_000_000n;
const MIN_GAS_PRICE = 1_000_000_000n;
const STORAGE_PER_BYTE = 10_000_000_000_000_000_000n;
const TRANSFER_GAS = 446_365_125_000n;
const CREATE_GAS = 7_903_530_250_000n;

/** Demo implicit account of NEAR account `account` (a label hash, NOT an ed25519 derivation). */
export function demoNearAddress(account: number): string {
  return bytesToHex(sha256(new TextEncoder().encode(`kyro-demo-near-account-${account}`)));
}

const invalidInput = (m: string) => new IpcError('INVALID_INPUT', sentence(m));

export const nearText = (yocto: bigint | string): string => {
  const v = BigInt(yocto);
  const frac = (v % YOCTO).toString().padStart(24, '0').replace(/0+$/, '');
  return `${v / YOCTO}${frac ? `${decimalMark()}${frac}` : ''} NEAR`;
};

/** wallet-core `near_account_kind`, same messages family as Rust. */
export function checkNearAccount(a: unknown): string {
  const s = String(a ?? '').trim();
  if (nearAccountKind(s) === null) throw invalidInput(l10n('identifiant de compte NEAR invalide', 'invalid NEAR account id'));
  return s;
}

interface DemoNearAccount {
  balance: bigint;
  storageUsage: number;
  nonce: bigint;
}

interface DemoTransfer {
  signerId: string;
  nonce: string;
  receiverId: string;
  deposit: string;
  blockHash: string;
  signature?: string;
}

export interface DemoNearDeps {
  network: Network;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
  now: () => number;
}

export interface DemoNearState {
  me: string;
  friend: string;
  accounts: Map<string, DemoNearAccount>;
  history: NearHistoryEntry[];
  failNext: string | null;
}

export function createDemoNear(d: DemoNearDeps) {
  const netKey = d.network === 'mainnet' ? 'mainnet' : 'testnet';
  const suffix = d.network === 'mainnet' ? 'near' : 'testnet';
  const me = demoNearAddress(0);
  const friend = `kyro-ami.${suffix}`;
  const exchange = `depot-kyro.${suffix}`;
  const t0 = d.now();
  const hashOf = (label: string) => base58.encode(sha256(new TextEncoder().encode(label)));
  const state: DemoNearState = {
    me,
    friend,
    accounts: new Map([
      [me, { balance: 42n * YOCTO + YOCTO / 2n, storageUsage: 182, nonce: 187_000_000_000_004n }],
      [friend, { balance: 310n * YOCTO, storageUsage: 264, nonce: 1n }],
      [exchange, { balance: 9_000_000n * YOCTO, storageUsage: 30_000, nonce: 1n }],
    ]),
    history: [
      { hash: hashOf('near-in-2'), from: exchange, to: me, kind: 'transfer', deposit: (30n * YOCTO).toString(), fee: '44636512500000000000', height: 191_000_100, time: t0 - 86_400_000, success: true },
      { hash: hashOf('near-in-1'), from: friend, to: me, kind: 'transfer', deposit: (12n * YOCTO + YOCTO / 2n).toString(), fee: '44636512500000000000', height: 190_900_000, time: t0 - 4 * 86_400_000, success: true },
    ],
    failNext: null,
  };
  let height = d.network === 'mainnet' ? 222_500_000 : 275_680_000;
  const torOn = () => d.settings().tor.enabled;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const backend = async () => {
    if (torOn()) await d.tor.waitReady();
    await wait(40 + Math.random() * 100);
    height += 1;
  };

  const account = (id: string): NearAccountInfo => {
    const a = state.accounts.get(id);
    if (!a) return { accountId: id, exists: false, balance: '0', locked: '0', storageUsage: 0, storageReserve: '0', spendable: '0', hasContract: false };
    const reserve = BigInt(a.storageUsage) * STORAGE_PER_BYTE;
    return {
      accountId: id,
      exists: true,
      balance: a.balance.toString(),
      locked: '0',
      storageUsage: a.storageUsage,
      storageReserve: reserve.toString(),
      spendable: (a.balance > reserve ? a.balance - reserve : 0n).toString(),
      hasContract: false,
    };
  };

  const contextFor = (to: string): NearContext => {
    const receiver = account(to);
    const creates = !receiver.exists && nearAccountKind(to) === 'implicit';
    const gas = TRANSFER_GAS + (creates ? CREATE_GAS : 0n);
    return {
      account: account(me),
      receiver,
      createsAccount: creates,
      gasPrice: GAS_PRICE.toString(),
      feeEstimate: (gas * GAS_PRICE).toString(),
      feeBound: (gas * (GAS_PRICE > MIN_GAS_PRICE ? GAS_PRICE : MIN_GAS_PRICE) * 2n).toString(),
    };
  };

  const check = (s: NearTxSummary, c: NearContext) => {
    if (!c.account.exists) throw invalidInput(l10n('ton compte NEAR n’existe pas encore : il est créé par le premier NEAR reçu', 'your NEAR account does not exist yet: it is created by the first NEAR received'));
    if (!c.receiver.exists) {
      if (s.receiverKind === 'named') throw invalidInput(l10n(`le compte « ${s.receiverId} » n’existe pas : un compte nommé doit déjà exister (sinon les frais sont perdus)`, `the account “${s.receiverId}” does not exist: a named account must already exist (otherwise the fees are lost)`));
      if (s.receiverKind === 'ethImplicit') throw invalidInput(l10n('ce compte de style Ethereum (0x…) n’existe pas sur NEAR : Kyro ne le crée pas', 'this Ethereum-style account (0x…) does not exist on NEAR: Kyro does not create it'));
    }
    const need = BigInt(s.deposit) + BigInt(c.feeBound);
    if (need > BigInt(c.account.spendable)) {
      throw invalidInput(l10n(`solde disponible insuffisant : ${nearText(c.account.spendable)} disponibles (solde − réserve de stockage), il en faut ${nearText(need)} (montant + frais au plus)`, `insufficient available balance: ${nearText(c.account.spendable)} available (balance − storage reserve), ${nearText(need)} needed (amount + fees at most)`));
    }
  };

  const encode = (t: DemoTransfer) => bytesToHex(new TextEncoder().encode(JSON.stringify(t)));

  /** wallet-core near_decode_tx: signer = us, receiver valid, not ourselves, amount > 0. */
  const decode = (tx: unknown): { t: DemoTransfer; summary: NearTxSummary } => {
    let t: DemoTransfer;
    try {
      t = JSON.parse(new TextDecoder().decode(hexToBytes(String(tx ?? '').trim().toLowerCase()))) as DemoTransfer;
    } catch {
      throw invalidInput(l10n('transaction NEAR illisible', 'unreadable NEAR transaction'));
    }
    if (t.signerId !== me) throw invalidInput(l10n("transaction NEAR : le signataire n'est pas le compte de ce portefeuille", 'NEAR transaction: the signer is not this wallet’s account'));
    const kind = nearAccountKind(t.receiverId);
    if (kind === null) throw invalidInput(l10n('transaction NEAR : receiver_id invalide', 'NEAR transaction: invalid receiver_id'));
    if (t.receiverId === me) throw invalidInput(l10n('transaction NEAR : transfert à soi-même', 'NEAR transaction: transfer to yourself'));
    if (!/^\d+$/.test(t.deposit) || BigInt(t.deposit) === 0n) throw invalidInput(l10n('transaction NEAR : montant nul', 'NEAR transaction: zero amount'));
    const warnings: NearWarning[] = kind === 'ethImplicit' ? [{ kind: 'ethImplicitReceiver' }] : [];
    const { signature: _sig, ...bare } = t;
    void _sig;
    const unsigned = encode(bare);
    return {
      t,
      summary: {
        signerId: me,
        publicKey: `ed25519:${base58.encode(hexToBytes(me))}`,
        nonce: t.nonce,
        receiverId: t.receiverId,
        receiverKind: kind,
        deposit: t.deposit,
        blockHash: t.blockHash,
        hash: base58.encode(sha256(hexToBytes(unsigned))),
        warnings,
        requiresExtraConfirmation: warnings.length > 0,
      },
    };
  };

  const describe = (s: NearTxSummary, c: NearContext): string => {
    const kindText = { implicit: l10n('compte implicite : la clé publique du destinataire, en hexadécimal', 'implicit account: the recipient’s public key, in hexadecimal'), ethImplicit: l10n('compte de style Ethereum, contrôlé par une clé Ethereum', 'Ethereum-style account, controlled by an Ethereum key'), named: l10n('compte nommé', 'named account') }[s.receiverKind];
    let out = l10n(`Envoi NEAR${d.network === 'testnet' ? ' (testnet)' : ''}\n\nÀ : ${s.receiverId}\n(${kindText})\n\nMontant : ${nearText(s.deposit)} (${s.deposit} yoctoNEAR)\n`, `NEAR send${d.network === 'testnet' ? ' (testnet)' : ''}\n\nTo: ${s.receiverId}\n(${kindText})\n\nAmount: ${nearText(s.deposit)} (${s.deposit} yoctoNEAR)\n`);
    if (c.createsAccount) out += l10n("\nCe compte implicite n'existe pas encore : ce transfert le crée (frais de création inclus ci-dessous).\n", '\nThis implicit account does not exist yet: this transfer creates it (creation fee included below).\n');
    out += l10n(`\nFrais : ≈ ${nearText(c.feeEstimate)} — au plus ${nearText(c.feeBound)}\n`, `\nFee: ≈ ${nearText(c.feeEstimate)} — at most ${nearText(c.feeBound)}\n`);
    out += l10n(`Solde : ${nearText(c.account.balance)} · réservé au stockage : ${nearText(c.account.storageReserve)} · disponible : ${nearText(c.account.spendable)}\n`, `Balance: ${nearText(c.account.balance)} · reserved for storage: ${nearText(c.account.storageReserve)} · available: ${nearText(c.account.spendable)}\n`);
    out += l10n(`\nDe : ${s.signerId}\nClé : ${s.publicKey} · nonce ${s.nonce}\nHash de la transaction : ${s.hash}\n`, `\nFrom: ${s.signerId}\nKey: ${s.publicKey} · nonce ${s.nonce}\nTransaction hash: ${s.hash}\n`);
    return out;
  };

  const handlers: Record<Exclude<Extract<keyof Commands, `near_${string}`>, `near_stake_${string}`>, (a: Record<string, unknown>) => unknown> = {
    near_backend_info: (): NearBackendInfo => ({
      kind: 'default',
      network: netKey,
      label: d.network === 'mainnet' ? 'free.rpc.fastnear.com' : 'test.rpc.fastnear.com',
      history: d.network === 'mainnet' ? 'tx.main.fastnear.com' : 'tx.test.fastnear.com',
      tor: torOn(),
    }),
    near_address: (a) => {
      d.requireUnlocked();
      const n = a.account === undefined ? 0 : Number(a.account);
      if (!Number.isInteger(n) || n < 0 || n > 100) throw invalidInput(l10n('numéro de compte : au plus 100', 'account number: at most 100'));
      return demoNearAddress(n);
    },
    near_account: async (a) => {
      const id = checkNearAccount(a.accountId);
      await backend();
      return account(id);
    },
    near_txs: async (a) => {
      const id = checkNearAccount(a.accountId);
      await backend();
      return state.history.filter((t) => t.from === id || t.to === id).slice(0, 20);
    },
    near_token_balances: () => Promise.resolve([]),
    near_build_token_tx: () => Promise.reject(new Error(l10n('Démo : envoi de jetons NEAR non simulé', 'Demo: NEAR token sends are not simulated'))),
    near_build_tx: async (a) => {
      d.requireUnlocked();
      const to = checkNearAccount(a.to);
      const amount = String(a.amount ?? '').trim();
      if (!/^\d{1,40}$/.test(amount) || BigInt(amount) === 0n) throw invalidInput(l10n('montant en yoctoNEAR invalide', 'invalid yoctoNEAR amount'));
      await backend();
      const ours = state.accounts.get(me);
      if (!ours) throw invalidInput(l10n('ton compte NEAR n’existe pas encore (aucun NEAR reçu) ou ta clé en a été retirée', 'your NEAR account does not exist yet (no NEAR received) or your key was removed from it'));
      const tx = encode({ signerId: me, nonce: (ours.nonce + 1n).toString(), receiverId: to, deposit: amount, blockHash: base58.encode(sha256(new TextEncoder().encode(`block-${height}`))) });
      const { summary } = decode(tx);
      const context = contextFor(to);
      check(summary, context);
      return { tx, summary, context };
    },
    near_sign_tx: async (a) => {
      d.requireUnlocked();
      const { t, summary } = decode(a.tx);
      await backend();
      const context = contextFor(summary.receiverId);
      const ours = state.accounts.get(me);
      if (!ours || BigInt(summary.nonce) <= ours.nonce) throw invalidInput(l10n('nonce périmé (une autre transaction est passée entre-temps) : reconstruis le transfert', 'stale nonce (another transaction went through in the meantime): rebuild the transfer'));
      check(summary, context);
      d.checkPassword(a.password);
      if (!d.confirm(l10n(`Confirmer l'envoi NEAR\n${describe(summary, context)}`, `Confirm the NEAR send\n${describe(summary, context)}`))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      if (summary.requiresExtraConfirmation && !d.confirm(l10n('Attention : transfert à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?', 'Warning: transfer to check\nOnly sign if you know exactly why. Sign anyway?'))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      const signed = encode({ ...t, signature: bytesToHex(sha256(new TextEncoder().encode(`sig:${String(a.tx)}`))) });
      return { signed, hash: summary.hash, summary, context };
    },
    near_broadcast: async (a): Promise<NearTxOutcome> => {
      const { t, summary } = decode(a.signed);
      if (!t.signature) throw invalidInput(l10n('transaction NEAR non signée', 'unsigned NEAR transaction'));
      await backend();
      const ours = state.accounts.get(me);
      if (!ours || BigInt(summary.nonce) <= ours.nonce) throw invalidInput(l10n('transaction NEAR refusée par le réseau : InvalidNonce', 'NEAR transaction rejected by the network: InvalidNonce'));
      const c = contextFor(summary.receiverId);
      const fee = BigInt(c.feeEstimate);
      const deposit = BigInt(summary.deposit);
      if (deposit + fee > BigInt(c.account.spendable)) throw invalidInput(l10n('transaction NEAR refusée par le réseau : NotEnoughBalance', 'NEAR transaction rejected by the network: NotEnoughBalance'));
      ours.nonce = BigInt(summary.nonce);
      ours.balance -= fee;
      const failure = state.failNext;
      state.failNext = null;
      if (!failure) {
        ours.balance -= deposit;
        const dest = state.accounts.get(summary.receiverId);
        if (dest) dest.balance += deposit;
        else state.accounts.set(summary.receiverId, { balance: deposit, storageUsage: 182, nonce: 0n });
      }
      state.history.unshift({ hash: summary.hash, from: me, to: summary.receiverId, kind: 'transfer', deposit: summary.deposit, fee: fee.toString(), height: height + 1, time: d.now(), success: !failure });
      return { hash: summary.hash, status: failure ? 'failure' : 'success', message: failure ?? '' };
    },
    near_tx_status: async (a): Promise<NearTxOutcome> => {
      const h = String(a.hash ?? '').trim();
      const ok = (() => {
        try {
          return base58.decode(h).length === 32;
        } catch {
          return false;
        }
      })();
      if (!ok) throw invalidInput(l10n('hash NEAR invalide (32 octets en base58 attendus)', 'invalid NEAR hash (32 bytes in base58 expected)'));
      await backend();
      const e = state.history.find((t) => t.hash === h);
      if (!e) return { hash: h, status: 'pending', message: '' };
      return { hash: h, status: e.success ? 'success' : 'failure', message: '' };
    },
  };

  return { state, handlers };
}
