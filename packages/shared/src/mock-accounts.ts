// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — several accounts per chain (docs/IPC.md §2.9), mirroring
// apps/desktop/src-tauri/src/accounts.rs: per-chain account lists (public bookmarks: index +
// name), `accounts_get({ account })`, and the « Compte signataire » line of the simulated
// native dialog (« inconnu » + reinforced confirmation for an account outside the list).
// Account 0 is exactly the demo vault's existing account. Demo keys only (public seed).

import { HDKey } from '@scure/bip32';
import { base58 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import {
  ACCOUNT_CHAINS,
  IpcError,
  MAX_ACCOUNT_NAME,
  MAX_ACCOUNTS_PER_CHAIN,
  MAX_VAULT_ACCOUNT,
  type AccountChain,
  type Accounts,
  type BtcKind,
  type Network,
  type VaultAccountEntry,
  type VaultAccountLists,
} from './ipc';
import { demoUtxoAccount, type DemoUtxoCoin } from './mock-utxo';
import { demoTronAddress } from './mock-tron';
import { demoXrpAddress } from './mock-xrp';
import { demoStellarAddress } from './mock-stellar';
import { demoNearAddress } from './mock-near';
import { demoSuiAddress } from './mock-sui';
import { demoHbarAddress } from './mock-hbar';
import { demoKaspaAddress } from './mock-kaspa';
import { demoDotAddress } from './mock-dot';
import { demoAlgoAddress } from './mock-algo';
import { demoXmrAddress } from './mock-xmr';
import { demoTonAddress } from './mock-ton';
import { demoFund } from './mock-tx';
import type { DemoChainState } from './mock-net';
import { l10n } from './i18n';

bitcoin.initEccLib(ecc);

const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf };

/** Same names as accounts.rs `Chain::label` (default names « Bitcoin 2 »…). */
export const ACCOUNT_CHAIN_LABEL: Record<AccountChain, string> = {
  btc: 'Bitcoin',
  evm: 'Ethereum',
  sol: 'Solana',
  ltc: 'Litecoin',
  doge: 'Dogecoin',
  tron: 'TRON',
  xrp: 'XRP',
  ada: 'Cardano',
  xlm: 'Stellar',
  near: 'NEAR',
  bch: 'Bitcoin Cash',
  dash: 'Dash',
  sui: 'Sui',
  hbar: 'Hedera',
  kas: 'Kaspa',
  dot: 'Polkadot',
  algo: 'Algorand',
  xmr: 'Monero',
  ton: 'TON',
};

export const defaultAccountName = (chain: AccountChain, index: number): string => `${ACCOUNT_CHAIN_LABEL[chain]} ${index + 1}`;

export interface DemoSigner {
  line: string;
  unknown: boolean;
  unknownText: string;
}

/** What the per-chain demo modules need from the account lists. */
export interface DemoAccountHooks {
  /** Validated `account` argument (absent = 0), like `account_arg`. */
  arg(a: unknown): number;
  /** Litecoin / Dogecoin / Bitcoin Cash / Dash account node of `account` (> 0). */
  utxoNode(coin: DemoUtxoCoin, account: number): HDKey;
  signer(chain: AccountChain, account: number, path: string): DemoSigner;
}

export interface DemoAccounts extends DemoAccountHooks {
  get(account: number): Accounts;
  /** `ada_address` of account `account` > 0 (the Cardano demo module only knows account 0). */
  adaAddress(account: number): { address: string; path: string; stakeAddress: string; accountXpub: string };
  /** Every Bitcoin address of `account` (receive + change, both kinds, 20 each): change detection. */
  ownBtc(account: number): Set<string>;
  lists(): VaultAccountLists;
  add(chain: unknown, account: unknown, name: unknown): VaultAccountLists;
  rename(chain: unknown, account: unknown, name: unknown): VaultAccountLists;
  remove(chain: unknown, account: unknown): VaultAccountLists;
}

const invalid = (m: string) => new IpcError('INVALID_INPUT', l10n(`Entrée invalide : ${m}`, `Invalid input: ${m}`));

function toChecksumAddress(hex40: string): string {
  const lower = hex40.toLowerCase();
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) out += parseInt(hash[i] ?? '0', 16) >= 8 ? (lower[i] ?? '').toUpperCase() : (lower[i] ?? '');
  return out;
}

export function createDemoAccounts(d: {
  network: Network;
  seed: Uint8Array;
  /** Account 0 = the demo vault's existing accounts (unchanged). */
  base: Accounts;
  baseOwnBtc: Set<string>;
  chain: DemoChainState;
  requireUnlocked: () => void;
}): DemoAccounts {
  const testnet = d.network === 'testnet';
  const net = testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const master = HDKey.fromMasterSeed(d.seed, testnet ? TESTNET_VERSIONS : undefined);
  const evmMaster = HDKey.fromMasterSeed(d.seed);
  const coin = testnet ? 1 : 0;
  const fingerprint = master.fingerprint.toString(16).padStart(8, '0');
  const cache = new Map<number, Accounts>();
  const ownCache = new Map<number, Set<string>>([[0, d.baseOwnBtc]]);
  const utxoNodes = new Map<string, HDKey>();
  const stored: Record<AccountChain, VaultAccountEntry[]> = Object.fromEntries(ACCOUNT_CHAINS.map((c) => [c, []])) as unknown as Record<AccountChain, VaultAccountEntry[]>;

  const btcAddr = (kind: BtcKind, pk: Uint8Array) => {
    const p = kind === 'segwit' ? bitcoin.payments.p2wpkh({ pubkey: pk, network: net }) : bitcoin.payments.p2tr({ internalPubkey: pk.slice(1, 33), network: net });
    if (!p.address) throw new IpcError('INTERNAL', l10n('Adresse démo introuvable', 'Demo address not found'));
    return p.address;
  };
  const btcInfo = (kind: BtcKind, a: number) => {
    const path = `m/${kind === 'segwit' ? 84 : 86}'/${coin}'/${a}'`;
    const acct = master.derive(path);
    const pk = acct.deriveChild(0).deriveChild(0).publicKey;
    if (!pk) throw new IpcError('INTERNAL', l10n('Clé démo introuvable', 'Demo key not found'));
    return { address: btcAddr(kind, pk), xpub: acct.publicExtendedKey, fingerprint, path };
  };
  const cardanoOf = (a: number): string => {
    const dec = bech32.decode(d.base.cardano.address as `${string}1${string}`, 1023);
    const bytes = bech32.fromWords(dec.words);
    const pay = sha256(new TextEncoder().encode(`kyro-demo-ada-payment-${a}`));
    const stake = sha256(new TextEncoder().encode(`kyro-demo-ada-stake-${a}`));
    bytes.set(pay.slice(0, 28), 1);
    bytes.set(stake.slice(0, 28), 29);
    return bech32.encode(dec.prefix, bech32.toWords(bytes), 1023);
  };

  const derive = (a: number): Accounts => {
    if (a === 0) return { ...structuredClone(d.base), account: 0 };
    const evmPk = evmMaster.derive(`m/44'/60'/0'/0/${a}`).publicKey;
    if (!evmPk) throw new IpcError('INTERNAL', l10n('Clé démo introuvable', 'Demo key not found'));
    const evm = toChecksumAddress(bytesToHex(keccak_256(ecc.pointCompress(evmPk, false).slice(1))).slice(-40));
    return {
      network: d.network,
      account: a,
      btc: { segwit: btcInfo('segwit', a), taproot: btcInfo('taproot', a) },
      evm: { address: evm, path: `m/44'/60'/0'/0/${a}` },
      sol: { address: base58.encode(sha256(new TextEncoder().encode(`kyro-demo-solana-account-${a}`))), path: `m/44'/501'/${a}'/0'` },
      ltc: demoUtxoAccount(d.seed, d.network, 'ltc', a).info,
      doge: demoUtxoAccount(d.seed, d.network, 'doge', a).info,
      bch: demoUtxoAccount(d.seed, d.network, 'bch', a).info,
      dash: demoUtxoAccount(d.seed, d.network, 'dash', a).info,
      tron: { address: demoTronAddress(d.seed, a), path: `m/44'/195'/${a}'/0/0` },
      xrp: { address: demoXrpAddress(d.seed, a), path: `m/44'/144'/${a}'/0/0` },
      stellar: { address: demoStellarAddress(d.seed, a), path: `m/44'/148'/${a}'` },
      cardano: { address: cardanoOf(a), path: `m/1852'/1815'/${a}'/0/0` },
      near: { address: demoNearAddress(a), path: `m/44'/397'/${a}'` },
      sui: { address: demoSuiAddress(a), path: `m/44'/784'/${a}'/0'/0'` },
      hbar: { address: demoHbarAddress(d.seed, a), path: `m/44'/3030'/0'/0/${a}` },
      kas: { address: demoKaspaAddress(d.seed, d.network, a), path: `m/44'/111111'/${a}'/0/0` },
      polkadot: { address: demoDotAddress(d.seed, a, d.network), path: `sr25519 · phrase//${a}` },
      algo: { address: demoAlgoAddress(a), path: `m/44'/283'/${a}'/0/0` },
      xmr: { address: demoXmrAddress(d.network, a), path: `m/44'/128'/${a}'/0/0` },
      ton: { address: demoTonAddress(a, d.network), path: `m/44'/607'/${a}'` },
    };
  };

  const arg = (v: unknown): number => {
    const a = v === undefined || v === null ? 0 : Number(v);
    if (!Number.isInteger(a) || a < 0 || a > MAX_VAULT_ACCOUNT) throw invalid(l10n(`numéro de compte : au plus ${MAX_VAULT_ACCOUNT}`, `account number: at most ${MAX_VAULT_ACCOUNT}`));
    return a;
  };
  const chainArg = (v: unknown): AccountChain => {
    if (typeof v === 'string' && (ACCOUNT_CHAINS as readonly string[]).includes(v)) return v as AccountChain;
    throw invalid(l10n(`chaîne inconnue « ${String(v)} »`, `unknown chain “${String(v)}”`));
  };
  const cleanName = (v: unknown): string => {
    const n = typeof v === 'string' ? v.trim() : '';
    if (!n || [...n].length > MAX_ACCOUNT_NAME || /\p{Cc}/u.test(n)) throw invalid(l10n(`nom du compte : 1 à ${MAX_ACCOUNT_NAME} caractères, sans caractère de contrôle`, `account name: 1 to ${MAX_ACCOUNT_NAME} characters, no control character`));
    return n;
  };
  const list = (c: AccountChain): VaultAccountEntry[] => {
    const out = stored[c].map((e) => ({ ...e }));
    if (!out.some((e) => e.index === 0)) out.push({ index: 0, name: defaultAccountName(c, 0) });
    return out.sort((x, y) => x.index - y.index);
  };
  const lists = (): VaultAccountLists => Object.fromEntries(ACCOUNT_CHAINS.map((c) => [c, list(c)])) as unknown as VaultAccountLists;
  const nameOf = (c: AccountChain, a: number) => list(c).find((e) => e.index === a)?.name ?? null;

  const get = (a: number): Accounts => {
    let acc = cache.get(a);
    if (!acc) {
      acc = derive(a);
      cache.set(a, acc);
    }
    return structuredClone(acc);
  };

  // Demo funds on the second account (index 1) so the « Ajouter un compte » scan finds a used one.
  {
    const a1 = get(1);
    const tip = d.chain.tipHeight;
    demoFund(d.chain.btcUtxos, d.chain.rawTx, a1.btc.segwit.address, net, 'acct1', 1_250_000, tip - 500);
    const chainId = testnet ? 11155111 : 1;
    d.chain.evmNative.set(`${chainId}:${a1.evm.address.toLowerCase()}`, 215_000_000_000_000_000n);
  }

  return {
    arg,
    get,
    adaAddress: (a) => {
      const address = get(a).cardano.address;
      const dec = bech32.decode(address as `${string}1${string}`, 1023);
      const bytes = bech32.fromWords(dec.words);
      const stake = new Uint8Array([0xe0 | ((bytes[0] ?? 0) & 0x0f), ...bytes.slice(29)]);
      return {
        address,
        path: `m/1852'/1815'/${a}'/0/0`,
        stakeAddress: bech32.encode(testnet ? 'stake_test' : 'stake', bech32.toWords(stake), 1023),
        accountXpub: bytesToHex(sha256(new TextEncoder().encode(`demo-ada-xpub-${a}`))).repeat(2),
      };
    },
    ownBtc: (a) => {
      let s = ownCache.get(a);
      if (!s) {
        s = new Set<string>();
        for (const kind of ['segwit', 'taproot'] as const) {
          const acct = master.derive(`m/${kind === 'segwit' ? 84 : 86}'/${coin}'/${a}'`);
          for (const change of [0, 1]) for (let i = 0; i < 20; i++) {
            const pk = acct.deriveChild(change).deriveChild(i).publicKey;
            if (pk) s.add(btcAddr(kind, pk));
          }
        }
        ownCache.set(a, s);
      }
      return s;
    },
    utxoNode: (c, a) => {
      const k = `${c}:${a}`;
      let n = utxoNodes.get(k);
      if (!n) {
        n = demoUtxoAccount(d.seed, d.network, c, a).node;
        utxoNodes.set(k, n);
      }
      return n;
    },
    signer: (c, a, path) => {
      const name = nameOf(c, a);
      return {
        line: name ? l10n(`Compte signataire : ${name} — ${path}`, `Signing account: ${name} — ${path}`) : l10n(`Compte signataire : « inconnu » (n° ${a + 1} ${ACCOUNT_CHAIN_LABEL[c]}, absent de ta liste) — ${path}`, `Signing account: “unknown” (no. ${a + 1} ${ACCOUNT_CHAIN_LABEL[c]}, not in your list) — ${path}`),
        unknown: name === null,
        unknownText: l10n(`Attention : compte inconnu\nCette signature utilise un compte ${ACCOUNT_CHAIN_LABEL[c]} qui n'est PAS dans ta liste de comptes :\n• n° ${a + 1} — ${path}\n\nSigner quand même ?`, `Warning: unknown account\nThis signature uses a ${ACCOUNT_CHAIN_LABEL[c]} account that is NOT in your account list:\n• no. ${a + 1} — ${path}\n\nSign anyway?`),
      };
    },
    lists,
    add: (chain, account, name) => {
      d.requireUnlocked();
      const c = chainArg(chain);
      const a = arg(account);
      const n = cleanName(name);
      const cur = list(c);
      if (cur.some((e) => e.index === a)) throw invalid(l10n('ce compte est déjà dans ta liste', 'this account is already in your list'));
      if (cur.length >= MAX_ACCOUNTS_PER_CHAIN) throw invalid(l10n(`au plus ${MAX_ACCOUNTS_PER_CHAIN} comptes par chaîne`, `at most ${MAX_ACCOUNTS_PER_CHAIN} accounts per chain`));
      stored[c] = [...stored[c], { index: a, name: n }].sort((x, y) => x.index - y.index);
      return lists();
    },
    rename: (chain, account, name) => {
      d.requireUnlocked();
      const c = chainArg(chain);
      const a = arg(account);
      const n = cleanName(name);
      if (nameOf(c, a) === null) throw invalid("ce compte n'est pas dans ta liste");
      const e = stored[c].find((x) => x.index === a);
      if (e) e.name = n;
      else stored[c] = [...stored[c], { index: a, name: n }].sort((x, y) => x.index - y.index);
      return lists();
    },
    remove: (chain, account) => {
      d.requireUnlocked();
      const c = chainArg(chain);
      const a = arg(account);
      if (a === 0) throw invalid(l10n('le premier compte ne peut pas être retiré (tu peux le renommer)', 'the first account cannot be removed (you can rename it)'));
      if (!stored[c].some((e) => e.index === a)) throw invalid("ce compte n'est pas dans ta liste");
      stored[c] = stored[c].filter((e) => e.index !== a);
      return lists();
    },
  };
}
