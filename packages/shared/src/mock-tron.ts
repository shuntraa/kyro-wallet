// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — TRON (`tron_*`, docs/IPC.md §2.5), mirroring apps/desktop/src-tauri/src/
// commands_tron.rs and tron_backend.rs: the address is really derived (m/44'/195'/0'/0/i,
// base58check 0x41 ‖ keccak256(pubkey)[12..]); `raw_data` is a demo encoding (hex JSON, NOT the
// protobuf Rust builds), the signature is fake. The resource estimate follows Rust exactly:
// bandwidth = signed size + 64 (free, then staked, else burned), activation of a new account
// (1 TRX + 0.1 TRX), simulated TRC-20 energy, fee_limit = energy × price × 1.3 (≥ 1 TRX).
//
// Scenario words in a custom server URL: « down » → SERVER_UNREACHABLE, « wrong » →
// SERVER_WRONG_NETWORK (Shasta); a custom server without « grid » in its URL behaves like a plain
// java-tron node: no `/v1` API, so `tron_txs` fails (SERVER_UNREACHABLE) while the rest works.

import { HDKey } from '@scure/bip32';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  IpcError,
  type Commands,
  type Network,
  type ServerTestResult,
  type Settings,
  type TronAccountInfo,
  type TronAction,
  type TronBackendInfo,
  type TronEstimate,
  type TronHistoryEntry,
  type TronServer,
  type TronTxSummary,
  type TronWarning,
} from './ipc';
import { checkServerUrl } from './servers';
import type { DemoTor } from './mock-tor';

/** Same as TRON_USDT of packages/chains and KNOWN_TOKENS of commands_tron.rs. */
export const DEMO_TRON_USDT: Record<Network, string> = {
  mainnet: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  testnet: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
};

/** Block 0 ids (servers.rs TRON_GENESIS). */
const GENESIS: Record<Network, string> = {
  mainnet: '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc',
  testnet: '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc',
};

/** `getchainparameters` (sun): energy price, bandwidth price, account creation, max fee_limit. */
const PARAMS = { energyFee: 100, bandwidthFee: 1000, createAccountFee: 1_000_000, createAccountBandwidthFee: 100_000, maxFeeLimit: 15_000_000_000 };
const SIGNED_OVERHEAD = 3 + 2 + 65;
const RESULT_SIZE = 64;
const MIN_FEE_LIMIT = 1_000_000;
const EXPIRATION_MS = 10 * 60 * 1000;
/** Demo `raw_data` sizes (bytes), close to real ones: TransferContract, TriggerSmartContract transfer(). */
const RAW_SIZE = { trx: 132, trc20: 209 };
/** Simulated USDT `transfer` energy: recipient already holds the token / first time. */
const ENERGY = { holder: 31_895, newHolder: 64_895 };
const FREE_BANDWIDTH = 600;

/** `T…` address of a secp256k1 public key (compressed or not). */
export function tronAddressOf(pubkey: Uint8Array): string {
  const full = pubkey.length === 65 ? pubkey : ecc.pointCompress(pubkey, false);
  const hash = keccak_256(full.slice(1)).slice(-20);
  return bitcoin.address.toBase58Check(hash, 0x41);
}

/** Demo address of TRON account `account` (`m/44'/195'/account'/0/0`, like Rust). */
export function demoTronAddress(seed: Uint8Array, account: number): string {
  const pk = HDKey.fromMasterSeed(seed).derive(`m/44'/195'/${account}'/0/0`).publicKey;
  if (!pk) throw new IpcError('INTERNAL', 'dérivation TRON');
  return tronAddressOf(pk);
}

function isTron(a: string): boolean {
  try {
    const { version, hash } = bitcoin.address.fromBase58Check(a);
    return version === 0x41 && hash.length === 20;
  } catch {
    return false;
  }
}

export interface DemoTronDeps {
  network: Network;
  seed: Uint8Array;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
  now: () => number;
  /** Staking raw_data (§2.8) goes through `tron_broadcast` too: null = not a staking tx. */
  stakeBroadcast?: (raw: string, signature: string) => string | null;
}

/** Demo chain state (exposed for tests). */
export interface DemoTronState {
  me: string;
  /** Sun per address; absent = account does not exist on chain. */
  trx: Map<string, bigint>;
  /** `${contract}:${address}` → raw units. */
  tokens: Map<string, bigint>;
  freeBandwidthUsed: Map<string, number>;
  staked: Map<string, { bandwidth: number; energy: number }>;
  history: TronHistoryEntry[];
  block: number;
}

const invalidInput = (m: string) => new IpcError('INVALID_INPUT', `Entrée invalide : ${m}`);
const unreachable = (m: string) => new IpcError('SERVER_UNREACHABLE', `Serveur injoignable : ${m}`);
const has = (s: string, w: string) => s.toLowerCase().includes(w);
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};
const trxText = (sun: bigint | string) => {
  const v = BigInt(sun);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${frac ? `,${frac}` : ''} TRX`;
};

interface DemoRaw {
  refBlockBytes: string;
  refBlockHash: string;
  expiration: number;
  timestamp: number;
  feeLimit: string;
  owner: string;
  action: TronAction;
}

export function createDemoTron(d: DemoTronDeps) {
  const netKey = d.network === 'mainnet' ? 'mainnet' : 'testnet';
  const usdt = DEMO_TRON_USDT[d.network];
  const me = demoTronAddress(d.seed, 0);
  // A demo sender (exists, holds USDT) and the seed's second address (does NOT exist: activation).
  const friend = bitcoin.address.toBase58Check(sha256(new TextEncoder().encode('kyro-demo-tron-friend')).slice(0, 20), 0x41);
  const t0 = d.now();
  const state: DemoTronState = {
    me,
    trx: new Map([
      [me, 35_000_000n],
      [friend, 4_200_000_000n],
    ]),
    tokens: new Map([
      [`${usdt}:${me}`, 120_500_000n],
      [`${usdt}:${friend}`, 9_000_000_000n],
    ]),
    freeBandwidthUsed: new Map(),
    staked: new Map(),
    history: [
      { txid: bytesToHex(sha256(new TextEncoder().encode('tron-in-usdt'))), kind: 'trc20', from: friend, to: me, amount: '120500000', token: { contract: usdt, symbol: 'USDT', decimals: 6 }, timestamp: t0 - 2 * 86_400_000, status: 'confirmed' },
      { txid: bytesToHex(sha256(new TextEncoder().encode('tron-in-trx'))), kind: 'trx', from: friend, to: me, amount: '35000000', timestamp: t0 - 5 * 86_400_000, status: 'confirmed' },
    ],
    block: d.network === 'mainnet' ? 76_120_554 : 61_482_317,
  };

  const torOn = () => d.settings().tor.enabled;
  const serverOf = (): TronServer => d.settings().servers.tron?.[netKey] ?? { kind: 'default' };
  const baseHost = (s: TronServer) => (s.kind === 'http' ? hostOf(s.url) : d.network === 'mainnet' ? 'api.trongrid.io' : 'nile.trongrid.io');
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Gate of every read: the right server, Tor, no fallback. */
  const backend = async (): Promise<TronServer> => {
    const s = serverOf();
    if (s.kind === 'http') {
      const bad = checkServerUrl(s.url, torOn());
      if (bad) throw new IpcError('SERVER_INVALID', `Serveur invalide : ${bad}`);
    }
    if (torOn()) await d.tor.waitReady();
    await wait(60 + Math.random() * 140);
    if (s.kind === 'http' && has(s.url, 'down')) throw unreachable(`${hostOf(s.url)} : délai de connexion dépassé`);
    return s;
  };

  const checkAddress = (a: unknown, what = 'adresse'): string => {
    const addr = String(a ?? '').trim();
    if (!isTron(addr)) throw invalidInput(`${what} TRON invalide « ${addr} »`);
    return addr;
  };

  const account = (address: string): TronAccountInfo => {
    const bal = state.trx.get(address);
    const st = state.staked.get(address) ?? { bandwidth: 0, energy: 0 };
    return {
      address,
      exists: bal !== undefined,
      balance: (bal ?? 0n).toString(),
      freeBandwidthLimit: bal !== undefined ? FREE_BANDWIDTH : 0,
      freeBandwidthUsed: state.freeBandwidthUsed.get(address) ?? 0,
      bandwidthLimit: st.bandwidth,
      bandwidthUsed: 0,
      energyLimit: st.energy,
      energyUsed: 0,
    };
  };

  const tokenBalance = (contract: string, address: string) => state.tokens.get(`${contract}:${address}`) ?? 0n;

  /** `triggerconstantcontract` of transfer(to, amount): reverts when the balance is short. */
  const simulateEnergy = (contract: string, to: string, amount: bigint): number => {
    if (contract !== usdt && !state.tokens.has(`${contract}:${me}`)) throw unreachable('TRON : simulation refusée (contrat introuvable)');
    if (tokenBalance(contract, me) < amount) throw invalidInput('le transfert de token échouerait (REVERT) : solde de token insuffisant ?');
    return tokenBalance(contract, to) > 0n ? ENERGY.holder : ENERGY.newHolder;
  };

  const feeLimitFor = (energy: number) => Math.min(Math.max(Math.floor((energy * PARAMS.energyFee * 130) / 100), MIN_FEE_LIMIT), PARAMS.maxFeeLimit);

  /** tron_backend::estimate, same formula. */
  const estimate = (rawSize: number, recipientExists: boolean, isTrx: boolean, energyNeeded: number, feeLimit: number): TronEstimate => {
    const acc = account(me);
    const needed = rawSize + (rawSize < 128 ? 1 : 2) + SIGNED_OVERHEAD + RESULT_SIZE;
    const free = Math.max(0, acc.freeBandwidthLimit - acc.freeBandwidthUsed);
    const staked = Math.max(0, acc.bandwidthLimit - acc.bandwidthUsed);
    let bandwidthBurn = 0;
    let activation = 0;
    if (isTrx && !recipientExists) {
      activation = PARAMS.createAccountFee + (staked >= needed ? 0 : PARAMS.createAccountBandwidthFee);
    } else if (!(staked >= needed || free >= needed)) {
      bandwidthBurn = needed * PARAMS.bandwidthFee;
    }
    const energyAvailable = Math.max(0, acc.energyLimit - acc.energyUsed);
    const energyBurn = isTrx ? 0 : Math.min(Math.max(0, energyNeeded - energyAvailable) * PARAMS.energyFee, feeLimit);
    return {
      bandwidthNeeded: needed,
      freeBandwidth: free,
      stakedBandwidth: staked,
      bandwidthBurn: String(bandwidthBurn),
      activationFee: String(activation),
      recipientExists,
      energyNeeded,
      energyAvailable,
      energyFee: PARAMS.energyFee,
      energyBurn: String(energyBurn),
      feeLimit: String(feeLimit),
      totalBurn: String(bandwidthBurn + activation + energyBurn),
      totalBurnMax: String(bandwidthBurn + activation + feeLimit),
      balance: acc.balance,
    };
  };

  const encodeRaw = (r: DemoRaw) => bytesToHex(new TextEncoder().encode(JSON.stringify(r)));

  /** tron_decode_raw: owner must be us, TRX > 0, not to ourselves. */
  const decodeRaw = (rawHex: unknown): { raw: DemoRaw; summary: TronTxSummary } => {
    let raw: DemoRaw;
    try {
      raw = JSON.parse(new TextDecoder().decode(hexToBytes(String(rawHex ?? '').trim()))) as DemoRaw;
    } catch {
      throw invalidInput('raw_data TRON illisible');
    }
    if (raw.owner !== me) throw invalidInput('le propriétaire de la transaction n’est pas ton adresse TRON');
    const a = raw.action;
    if (a.type === 'trxTransfer' && (BigInt(a.amount) <= 0n || a.to === me)) throw invalidInput('montant TRX invalide ou envoi à soi-même');
    const warnings: TronWarning[] = [];
    if (a.type === 'contractCall') warnings.push({ kind: 'unknownCall', selector: a.selector });
    if (a.type !== 'trxTransfer' && a.callValue !== '0') warnings.push({ kind: 'callValue' });
    if (BigInt(raw.feeLimit) > 100_000_000n) warnings.push({ kind: 'highFeeLimit' });
    const hex = String(rawHex).trim();
    const summary: TronTxSummary = {
      txid: bytesToHex(sha256(hexToBytes(hex))),
      owner: raw.owner,
      action: a,
      feeLimit: raw.feeLimit,
      expiration: raw.expiration,
      timestamp: raw.timestamp,
      refBlockBytes: raw.refBlockBytes,
      refBlockHash: raw.refBlockHash,
      memo: '',
      rawSize: a.type === 'trxTransfer' ? RAW_SIZE.trx : RAW_SIZE.trc20,
      warnings,
      requiresExtraConfirmation: warnings.length > 0,
    };
    return { raw, summary };
  };

  /** Live estimate of a decoded transaction (tron_backend::estimate_for). */
  const estimateFor = (s: TronTxSummary): TronEstimate => {
    const a = s.action;
    if (a.type === 'trxTransfer') return estimate(s.rawSize, account(a.to).exists, true, 0, Number(s.feeLimit));
    if (a.type === 'trc20Transfer') return estimate(s.rawSize, true, false, simulateEnergy(a.contract, a.to, BigInt(a.amount)), Number(s.feeLimit));
    return estimate(s.rawSize, true, false, 0, Number(s.feeLimit));
  };

  /** commands_tron.rs describe_tron, same lines. */
  const describe = (s: TronTxSummary, e: TronEstimate): string => {
    const units = (v: string, dec: number) => {
      const b = BigInt(v);
      const p = 10n ** BigInt(dec);
      const frac = (b % p).toString().padStart(dec, '0').replace(/0+$/, '');
      return `${b / p}${frac ? `,${frac}` : ''}`;
    };
    let out = `Envoi ${d.network === 'mainnet' ? 'TRON' : 'TRON Nile (testnet)'}\n\n`;
    const a = s.action;
    if (a.type === 'trxTransfer') {
      out += `À : ${a.to}\nMontant : ${trxText(a.amount)}\n`;
      if (!e.recipientExists) out += `\nCe compte n'existe pas encore sur TRON : l'activer brûle ${trxText(e.activationFee)} en plus.\n`;
    } else if (a.type === 'trc20Transfer') {
      // Like Rust: only its own table names a token; anything else is « jeton inconnu ».
      const known = a.contract === usdt;
      const shown = known ? `${units(a.amount, 6)} USDT (unités brutes : ${a.amount})` : `${a.amount} unités brutes (jeton inconnu : décimales non vérifiées)`;
      out += `Envoi de token TRC-20${known ? '' : ' (JETON INCONNU)'} : ${shown}\nContrat du token : ${a.contract}\nÀ : ${a.to}\n`;
    } else {
      out += `Appel de contrat INCONNU : ${a.contract}\nFonction (sélecteur) : ${a.selector}\n`;
    }
    const src = e.stakedBandwidth >= e.bandwidthNeeded ? 'bande passante gelée' : e.freeBandwidth >= e.bandwidthNeeded ? 'bande passante gratuite' : 'TRX brûlés';
    out += `\nBande passante : ${e.bandwidthNeeded} octets nécessaires · disponible ${e.freeBandwidth} gratuite + ${e.stakedBandwidth} gelée → ${trxText(e.bandwidthBurn)} (${src})\n`;
    if (a.type !== 'trxTransfer') {
      out += `Énergie : ${e.energyNeeded} estimée · ${e.energyAvailable} disponible → ≈ ${trxText(e.energyBurn)} brûlés (${e.energyFee} sun par unité)\nTRX brûlés au maximum pour l'énergie (fee_limit) : ${trxText(s.feeLimit)}\n`;
    }
    out += `\nTotal brûlé estimé : ${trxText(e.totalBurn)} · au maximum : ${trxText(e.totalBurnMax)}\nSolde : ${trxText(e.balance)}`;
    out += `\n\nExpire dans ${Math.max(0, Math.floor((s.expiration - d.now()) / 60_000))} min · bloc de référence ${s.refBlockBytes}/${s.refBlockHash}\nID : ${s.txid}`;
    return out;
  };

  const probe = async (network: string, s: TronServer): Promise<ServerTestResult['detected']> => {
    if (network !== 'mainnet' && network !== 'testnet') throw new IpcError('SERVER_INVALID', `Serveur invalide : tron : réseau inconnu « ${network} » (mainnet ou testnet)`);
    const want = network === 'mainnet' ? 'mainnet' : 'nile';
    if (s.kind === 'http') {
      const bad = checkServerUrl(s.url, torOn());
      if (bad) throw new IpcError('SERVER_INVALID', `Serveur invalide : tron ${network} : ${bad}`);
    }
    if (torOn()) await d.tor.waitReady();
    await wait(100 + Math.random() * 200);
    if (s.kind === 'http' && has(s.url, 'down')) throw unreachable(`${hostOf(s.url)} : délai de connexion dépassé`);
    if (s.kind === 'http' && has(s.url, 'wrong')) throw new IpcError('SERVER_WRONG_NETWORK', `Mauvais réseau : ce serveur TRON est sur shasta, pas sur ${want}`);
    return { network: want, genesisHash: GENESIS[network], blockHeight: state.block };
  };

  const handlers: Record<Exclude<Extract<keyof Commands, `tron_${string}`>, `tron_stake_${string}`>, (a: Record<string, unknown>) => unknown> = {
    tron_backend_info: (): TronBackendInfo => {
      const s = serverOf();
      return { kind: s.kind, network: netKey, label: baseHost(s), tor: torOn() };
    },
    tron_address: (a) => {
      d.requireUnlocked();
      if ((a.index ?? 0) !== 0) throw invalidInput('TRON : une seule adresse par compte (index 0)');
      const account = a.account === undefined ? 0 : Number(a.account);
      if (!Number.isInteger(account) || account < 0 || account > 100) throw invalidInput('numéro de compte : au plus 100');
      return demoTronAddress(d.seed, account);
    },
    tron_account: async (a) => {
      const addr = checkAddress(a.address);
      await backend();
      return account(addr);
    },
    tron_trc20_balance: async (a) => {
      const contract = checkAddress(a.contract, 'contrat');
      const addr = checkAddress(a.address);
      await backend();
      return tokenBalance(contract, addr).toString();
    },
    tron_txs: async (a) => {
      const addr = checkAddress(a.address);
      const s = await backend();
      if (s.kind === 'http' && !has(s.url, 'grid')) {
        throw unreachable(`TRON : HTTP 404 sur /v1/accounts/${addr}/transactions?limit=50 (l'historique exige l'API /v1 de TronGrid)`);
      }
      return state.history.filter((t) => t.from === addr || t.to === addr).sort((x, y) => (y.timestamp ?? Infinity) - (x.timestamp ?? Infinity));
    },
    tron_build_tx: async (a) => {
      d.requireUnlocked();
      const to = checkAddress(a.to);
      const amountStr = String(a.amount ?? '').trim();
      if (!/^[0-9]+$/.test(amountStr) || BigInt(amountStr) <= 0n) throw invalidInput('montant invalide');
      const amount = BigInt(amountStr);
      const token = a.token === undefined || a.token === null ? undefined : checkAddress(a.token, 'contrat');
      await backend();
      const ts = d.now();
      state.block += 1;
      const blockHex = state.block.toString(16).padStart(16, '0');
      let action: TronAction;
      let feeLimit = 0;
      let energy = 0;
      let exists = true;
      if (!token) {
        exists = account(to).exists;
        action = { type: 'trxTransfer', to, amount: amountStr };
      } else {
        energy = simulateEnergy(token, to, amount);
        feeLimit = feeLimitFor(energy);
        action = { type: 'trc20Transfer', contract: token, to, amount: amountStr, callValue: '0' };
      }
      const raw: DemoRaw = {
        refBlockBytes: blockHex.slice(12, 16),
        refBlockHash: bytesToHex(sha256(new TextEncoder().encode(`block:${state.block}`))).slice(16, 32),
        expiration: ts + EXPIRATION_MS,
        timestamp: ts,
        feeLimit: String(feeLimit),
        owner: me,
        action,
      };
      const rawHex = encodeRaw(raw);
      const { summary } = decodeRaw(rawHex);
      return { raw: rawHex, txid: summary.txid, summary, estimate: estimate(summary.rawSize, exists, !token, energy, feeLimit) };
    },
    tron_sign_tx: async (a) => {
      d.requireUnlocked();
      const { summary } = decodeRaw(a.raw);
      if (summary.expiration <= d.now()) throw invalidInput('transaction TRON expirée : reconstruis-la');
      if (summary.expiration > d.now() + 24 * 3600 * 1000) throw invalidInput('expiration TRON à plus de 24 h : refusée');
      d.checkPassword(a.password);
      await backend();
      const est = estimateFor(summary);
      if (!d.confirm(`Confirmer la transaction TRON\n${describe(summary, est)}`)) throw new IpcError('USER_REJECTED', 'Signature refusée.');
      const unknownToken = summary.action.type === 'trc20Transfer' && summary.action.contract !== usdt;
      if ((summary.requiresExtraConfirmation || unknownToken) && !d.confirm('Attention : transaction à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?')) throw new IpcError('USER_REJECTED', 'Signature refusée.');
      const r = sha256(new TextEncoder().encode(`r:${summary.txid}`));
      const s = sha256(new TextEncoder().encode(`s:${summary.txid}`));
      return { signature: bytesToHex(r) + bytesToHex(s) + '1b', txid: summary.txid, summary, estimate: est };
    },
    tron_broadcast: async (a) => {
      if (!/^[0-9a-f]{130}$/i.test(String(a.signature ?? '').trim())) throw invalidInput('signature : 65 octets hex');
      const staked = d.stakeBroadcast?.(String(a.raw ?? ''), String(a.signature));
      if (staked) {
        await backend();
        return staked;
      }
      const { summary } = decodeRaw(a.raw);
      await backend();
      const est = estimateFor(summary);
      const burn = BigInt(est.totalBurn);
      const bal = state.trx.get(me) ?? 0n;
      const act = summary.action;
      const sent = act.type === 'trxTransfer' ? BigInt(act.amount) : 0n;
      if (bal < sent + burn) throw invalidInput('diffusion TRON refusée : CONTRACT_VALIDATE_ERROR balance is not sufficient');
      state.trx.set(me, bal - sent - burn);
      if (est.freeBandwidth >= est.bandwidthNeeded && est.recipientExists && BigInt(est.bandwidthBurn) === 0n) {
        state.freeBandwidthUsed.set(me, (state.freeBandwidthUsed.get(me) ?? 0) + est.bandwidthNeeded);
      }
      if (act.type === 'trxTransfer') {
        state.trx.set(act.to, (state.trx.get(act.to) ?? 0n) + sent);
        state.history.unshift({ txid: summary.txid, kind: 'trx', from: me, to: act.to, amount: act.amount, timestamp: d.now(), status: 'confirmed' });
      } else if (act.type === 'trc20Transfer') {
        const amt = BigInt(act.amount);
        state.tokens.set(`${act.contract}:${me}`, tokenBalance(act.contract, me) - amt);
        state.tokens.set(`${act.contract}:${act.to}`, tokenBalance(act.contract, act.to) + amt);
        const sym = act.contract === usdt ? 'USDT' : '?';
        state.history.unshift({ txid: summary.txid, kind: 'trc20', from: me, to: act.to, amount: act.amount, token: { contract: act.contract, symbol: sym, decimals: 6 }, timestamp: d.now(), status: 'confirmed' });
      }
      return summary.txid;
    },
  };

  return {
    state,
    handlers,
    probe,
    /** Syntax check of `servers.tron` (SERVER_INVALID prefixed by the slot). */
    validate: (servers: Settings['servers'], tor: boolean) => {
      for (const nk of ['mainnet', 'testnet'] as const) {
        const s = servers.tron?.[nk];
        if (s?.kind === 'http') {
          const bad = checkServerUrl(s.url, tor);
          if (bad) throw new IpcError('SERVER_INVALID', `Serveur invalide : tron ${nk} : ${bad}`);
        }
      }
    },
  };
}
