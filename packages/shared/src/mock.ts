// SPDX-License-Identifier: GPL-3.0-or-later
//
// MODE DÉMO — in-memory backend used automatically when the UI runs outside
// Tauri (plain `vite` in a browser, unit tests). It emulates every command of
// docs/IPC.md with a fake vault and fake chains, so all screens are demoable.
//
// ⚠ The demo "keys" come from a hard-coded, public seed. They protect nothing
// and are never used by the real application, which derives and signs in Rust.

import { HDKey } from '@scure/bip32';
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { base58, base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import {
  IpcError,
  type Accounts,
  type AppConfig,
  type BtcKind,
  type BtcTxSummary,
  type Commands,
  type EvmTxRequest,
  type EvmTxSummary,
  type Network,
  type Settings,
  type VaultStatus,
} from './ipc';
import { emitDemoEvent } from './events';
import { createDemoTor, detectDemoTorDisabled, detectDemoTorScenario, type DemoTor, type DemoTorScenario } from './mock-tor';
export { DEMO_TOR_BOOTSTRAP_MS, type DemoTor, type DemoTorScenario } from './mock-tor';
import { demoHash, handleDemoNet, type DemoChainState } from './mock-net';
import { demoDecodeSolMessage, demoSolSummaryText } from './mock-sol';

bitcoin.initEccLib(ecc);

export const DEMO_PASSWORD_HINT = 'Mode démo : n’importe quel mot de passe de 8 caractères ou plus.';

export const DEFAULT_SETTINGS: Settings = {
  currency: 'EUR',
  autoLockSecs: 900,
  hideBalancesOnStart: false,
  captureProtection: true,
  clipboardGuard: true,
  rpc: {},
  apiKeys: {},
  tor: { enabled: true },
};

const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf };
const MAX_UINT256 = (1n << 256n) - 1n;

interface DemoKeys {
  accounts: Accounts;
  /** Every address we own (receive + change, both kinds), for change detection. */
  ownBtc: Set<string>;
  receive: Record<BtcKind, HDKey>;
}

function demoSeed(): Uint8Array {
  const a = sha256(new TextEncoder().encode('kyro-demo-seed-public-do-not-use'));
  const out = new Uint8Array(64);
  out.set(a, 0);
  out.set(sha256(a), 32);
  return out;
}

function toChecksumAddress(addrHexNo0x: string): string {
  const lower = addrHexNo0x.toLowerCase();
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i] ?? '';
    out += parseInt(hash[i] ?? '0', 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

function btcAddressFor(kind: BtcKind, pubkey: Uint8Array, net: bitcoin.Network): string {
  const p = kind === 'segwit' ? bitcoin.payments.p2wpkh({ pubkey, network: net }) : bitcoin.payments.p2tr({ internalPubkey: pubkey.slice(1, 33), network: net });
  if (!p.address) throw new IpcError('INTERNAL', 'Adresse démo introuvable');
  return p.address;
}

export function deriveDemoKeys(network: Network): DemoKeys {
  const testnet = network === 'testnet';
  const master = HDKey.fromMasterSeed(demoSeed(), testnet ? TESTNET_VERSIONS : undefined);
  const net = testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const coin = testnet ? 1 : 0;
  const fingerprint = master.fingerprint.toString(16).padStart(8, '0');
  const ownBtc = new Set<string>();
  const receive = {} as Record<BtcKind, HDKey>;
  const info = (kind: BtcKind) => {
    const purpose = kind === 'segwit' ? 84 : 86;
    const path = `m/${purpose}'/${coin}'/0'`;
    const acct = master.derive(path);
    for (const change of [0, 1]) {
      const branch = acct.deriveChild(change);
      for (let i = 0; i < 20; i++) {
        const pk = branch.deriveChild(i).publicKey;
        if (pk) ownBtc.add(btcAddressFor(kind, pk, net));
      }
    }
    receive[kind] = acct.deriveChild(0);
    const first = acct.deriveChild(0).deriveChild(0).publicKey;
    if (!first) throw new IpcError('INTERNAL', 'Clé démo introuvable');
    return { address: btcAddressFor(kind, first, net), xpub: acct.publicExtendedKey, fingerprint, path };
  };
  const evmKey = master.derive("m/44'/60'/0'/0/0").publicKey;
  if (!evmKey) throw new IpcError('INTERNAL', 'Clé démo introuvable');
  const uncompressed = ecc.pointCompress(evmKey, false);
  const evmAddr = toChecksumAddress(bytesToHex(keccak_256(uncompressed.slice(1))).slice(-40));
  const solAddr = base58.encode(sha256(new TextEncoder().encode('kyro-demo-solana-account')));
  return {
    accounts: { network, btc: { segwit: info('segwit'), taproot: info('taproot') }, evm: { address: evmAddr }, sol: { address: solAddr } },
    ownBtc,
    receive,
  };
}

function seedChainState(keys: DemoKeys, network: Network): DemoChainState {
  const a = keys.accounts;
  const me = a.evm.address.toLowerCase();
  const testnet = network === 'testnet';
  const net = testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const addrAt = (kind: BtcKind, i: number) => {
    const pk = keys.receive[kind].deriveChild(i).publicKey;
    return pk ? btcAddressFor(kind, pk, net) : '';
  };
  const tip = testnet ? 98_430 : 871_402;
  const utxo = (seed: string, value: number, age: number) => ({ txid: demoHash(seed), vout: 0, value, height: tip - age });
  const btcUtxos = new Map([
    [a.btc.segwit.address, [utxo('u1', 4_120_000, 1_200), utxo('u2', 890_000, 300)]],
    [addrAt('segwit', 1), [utxo('u3', 210_000, 40)]],
    [a.btc.taproot.address, [utxo('u4', 350_000, 12)]],
  ]);
  const evmNative = new Map<string, bigint>();
  const evmTokens = new Map<string, bigint>();
  if (testnet) {
    evmNative.set(`11155111:${me}`, 842_100_000_000_000_000n);
    evmTokens.set(`11155111:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238:${me}`, 250_500_000n);
  } else {
    evmNative.set(`1:${me}`, 842_100_000_000_000_000n);
    evmNative.set(`42161:${me}`, 120_000_000_000_000_000n);
    evmTokens.set(`1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:${me}`, 250_500_000n);
    evmTokens.set(`42161:0x912ce59144191c1204e64559fe8253a0e49e6548:${me}`, 150_000_000_000_000_000_000n);
  }
  const usdcMint = testnet ? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  return {
    network,
    accounts: a,
    tipHeight: tip,
    btcUtxos,
    evmNative,
    evmTokens,
    allowances: new Map(),
    nonces: new Map(),
    signedEvm: new Map(),
    minedEvm: new Map(),
    solLamports: 3_200_000_000n,
    solTokens: new Map([[usdcMint, 42_000_000n]]),
  };
}

function fakeDerSignature(seed: string): Uint8Array {
  // Canonical-looking DER (r, s < 2^255) + SIGHASH_ALL. Not a valid signature.
  const r = sha256(new TextEncoder().encode(`r:${seed}`));
  const s = sha256(new TextEncoder().encode(`s:${seed}`));
  r[0] = (r[0] ?? 0) & 0x3f | 0x01;
  s[0] = (s[0] ?? 0) & 0x3f | 0x01;
  return new Uint8Array([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s, 0x01]);
}

export interface MockOptions {
  network?: Network;
  /** Emulates the native confirmation dialog. Default: `window.confirm` when available, else accept. */
  confirm?: (summary: string) => boolean;
  /** Start with an existing vault (tests). */
  preset?: { password: string; words?: string[]; unlocked?: boolean };
  /** Simulated Tor (see mock-tor.ts). Default: `?tor=…` in a browser, `ready` without `window`. */
  tor?: DemoTorScenario;
  /** Initial `settings.tor.enabled`. Default: true (`?tor=off` → false). */
  torEnabled?: boolean;
}

export interface MockBackend {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Exposed for tests. */
  chain: DemoChainState;
  /** Advance the fake clock (tests). */
  advance(ms: number): void;
  /** Simulated Tor (tests). */
  tor: DemoTor;
}

export function createMockBackend(opts: MockOptions = {}): MockBackend {
  const network: Network = opts.network ?? detectDemoNetwork();
  const keys = deriveDemoKeys(network);
  const chain = seedChainState(keys, network);
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;

  let vault: { password: string; words: string[] } | null = opts.preset
    ? { password: opts.preset.password, words: opts.preset.words ?? generateMnemonic(wordlist, 256).split(' ') }
    : null;
  let unlocked = opts.preset?.unlocked ?? false;
  let lastTouch = now();
  let failed = 0;
  let blockedUntil = 0;
  let reveals: number[] = [];
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);
  let captureProtected = false;
  settings.tor.enabled = opts.torEnabled ?? !detectDemoTorDisabled();
  // Like the shell's setup: Tor starts in the background when enabled.
  const tor = createDemoTor(opts.tor ?? detectDemoTorScenario());
  if (settings.tor.enabled) tor.start();

  const confirmFn =
    opts.confirm ??
    ((summary: string) => (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(`[MODE DÉMO — fenêtre système simulée]\n\n${summary}`) : true));

  const lockIfExpired = () => {
    if (unlocked && now() - lastTouch >= settings.autoLockSecs * 1000) {
      unlocked = false;
      emitDemoEvent('vault-locked');
    }
  };
  if (typeof window !== 'undefined') window.setInterval(lockIfExpired, 1000);

  const requireUnlocked = () => {
    lockIfExpired();
    if (!vault) throw new IpcError('LOCKED', 'Aucun coffre sur cet appareil.');
    if (!unlocked) throw new IpcError('LOCKED', 'Le coffre est verrouillé.');
  };

  const checkPassword = (password: unknown) => {
    if (!vault) throw new IpcError('LOCKED', 'Aucun coffre sur cet appareil.');
    if (now() < blockedUntil) {
      throw new IpcError('RATE_LIMITED', `Trop d’essais. Réessaie dans ${Math.ceil((blockedUntil - now()) / 1000)} s.`);
    }
    if (password !== vault.password) {
      failed += 1;
      if (failed >= 5) blockedUntil = now() + 5000 * 2 ** (failed - 5);
      throw new IpcError('WRONG_PASSWORD', 'Mot de passe incorrect.');
    }
    failed = 0;
  };

  const validPassword = (p: unknown): string => {
    if (typeof p !== 'string' || p.length < 8) throw new IpcError('INVALID_INPUT', 'Le mot de passe doit faire au moins 8 caractères.');
    return p;
  };

  const status = (): VaultStatus => {
    lockIfExpired();
    const left = Math.max(0, Math.ceil((lastTouch + settings.autoLockSecs * 1000 - now()) / 1000));
    return { exists: vault !== null, unlocked, autoLockSecs: settings.autoLockSecs, lockInSecs: unlocked ? left : null };
  };

  const decodeEvm = (tx: EvmTxRequest): EvmTxSummary => {
    const data = tx.data.toLowerCase();
    const maxFeeWei = (BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGas)).toString();
    const word = (i: number) => data.slice(10 + i * 64, 10 + (i + 1) * 64);
    const base = { tokenContract: null, spender: null, unlimitedApproval: false, maxFeeWei, chainId: tx.chainId };
    if (data === '0x' || data === '') return { ...base, kind: 'NativeTransfer', to: tx.to, amount: BigInt(tx.valueWei).toString() };
    if (data.startsWith('0xa9059cbb') && data.length >= 138) {
      return { ...base, kind: 'Erc20Transfer', to: toChecksumAddress(word(0).slice(24)), tokenContract: tx.to, amount: BigInt('0x' + word(1)).toString() };
    }
    if (data.startsWith('0x095ea7b3') && data.length >= 138) {
      const amount = BigInt('0x' + word(1));
      return { ...base, kind: 'Erc20Approve', to: tx.to, tokenContract: tx.to, spender: toChecksumAddress(word(0).slice(24)), amount: amount.toString(), unlimitedApproval: amount >= MAX_UINT256 / 2n };
    }
    return { ...base, kind: 'ContractCall', to: tx.to, amount: BigInt(tx.valueWei).toString() };
  };

  const signPsbt = (psbtB64: string): { psbt: string; summary: BtcTxSummary } => {
    const net = network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
    const psbt = bitcoin.Psbt.fromBase64(psbtB64, { network: net });
    let inSum = 0n;
    psbt.data.inputs.forEach((input, i) => {
      inSum += input.witnessUtxo?.value ?? 0n;
      if (input.tapInternalKey || input.tapBip32Derivation?.length) {
        const h = sha256(new TextEncoder().encode(`tap:${i}:${psbtB64}`));
        const tapKeySig = new Uint8Array(64);
        tapKeySig.set(h, 0);
        tapKeySig.set(sha256(h), 32);
        psbt.updateInput(i, { tapKeySig });
      } else {
        const pubkey = input.bip32Derivation?.[0]?.pubkey;
        if (!pubkey) throw new IpcError('INVALID_INPUT', `Entrée ${i} sans dérivation BIP32.`);
        psbt.updateInput(i, { partialSig: [{ pubkey, signature: fakeDerSignature(`${i}:${psbtB64}`) }] });
      }
    });
    const outputs = psbt.txOutputs.map((o) => {
      const address = o.address ?? bitcoin.address.fromOutputScript(o.script, net);
      return [address, Number(o.value), keys.ownBtc.has(address)] as [string, number, boolean];
    });
    const outSum = psbt.txOutputs.reduce((a, o) => a + o.value, 0n);
    return { psbt: psbt.toBase64(), summary: { outputs, feeSats: Number(inSum - outSum) } };
  };

  const handlers: { [K in keyof Commands]: (args: Record<string, unknown>) => unknown } = {
    vault_status: () => status(),
    vault_create: (a) => {
      if (vault) throw new IpcError('INVALID_INPUT', 'Un coffre existe déjà sur cet appareil.');
      const password = validPassword(a.password);
      const count = a.words === 12 ? 12 : 24;
      const words = generateMnemonic(wordlist, count === 12 ? 128 : 256).split(' ');
      vault = { password, words };
      unlocked = true;
      lastTouch = now();
      return { words: [...words] };
    },
    vault_import: (a) => {
      if (vault) throw new IpcError('INVALID_INPUT', 'Un coffre existe déjà sur cet appareil.');
      const password = validPassword(a.password);
      const phrase = String(a.phrase ?? '').trim().toLowerCase().split(/\s+/).join(' ');
      if (!validateMnemonic(phrase, wordlist)) throw new IpcError('INVALID_INPUT', 'Phrase de récupération invalide (mot inconnu ou somme de contrôle fausse).');
      vault = { password, words: phrase.split(' ') };
      unlocked = true;
      lastTouch = now();
    },
    vault_unlock: (a) => {
      checkPassword(a.password);
      unlocked = true;
      lastTouch = now();
    },
    vault_lock: () => {
      unlocked = false;
    },
    vault_reveal_mnemonic: (a) => {
      requireUnlocked();
      reveals = reveals.filter((t) => now() - t < 60_000);
      if (reveals.length >= 3) throw new IpcError('RATE_LIMITED', 'Trop de demandes. Réessaie dans une minute.');
      checkPassword(a.password);
      reveals.push(now());
      return { words: [...(vault?.words ?? [])] };
    },
    session_touch: () => {
      lockIfExpired();
      if (unlocked) lastTouch = now();
    },
    accounts_get: () => {
      requireUnlocked();
      return structuredClone(keys.accounts);
    },
    btc_address: (a) => {
      requireUnlocked();
      const kind: BtcKind = a.kind === 'taproot' ? 'taproot' : 'segwit';
      const index = Number(a.index);
      if (!Number.isInteger(index) || index < 0 || index > 2 ** 31 - 1) throw new IpcError('INVALID_INPUT', 'Index invalide.');
      const testnet = network === 'testnet';
      const master = HDKey.fromMasterSeed(demoSeed(), testnet ? TESTNET_VERSIONS : undefined);
      const path = `m/${kind === 'segwit' ? 84 : 86}'/${testnet ? 1 : 0}'/0'/${a.change ? 1 : 0}/${index}`;
      const pk = master.derive(path).publicKey;
      if (!pk) throw new IpcError('INTERNAL', 'Dérivation impossible.');
      return btcAddressFor(kind, pk, testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin);
    },
    evm_decode_tx: (a) => decodeEvm(a.tx as EvmTxRequest),
    evm_sign_tx: (a) => {
      requireUnlocked();
      checkPassword(a.password);
      const tx = a.tx as EvmTxRequest;
      const s = decodeEvm(tx);
      const token = a.token as { symbol: string; decimals: number } | undefined;
      if (!confirmFn(`Signer une transaction ${s.kind} sur la chaîne ${tx.chainId}\nVers : ${s.to}\nMontant : ${s.amount}${token ? ` (${token.symbol}, ${token.decimals} déc.)` : ' wei'}\nFrais max. : ${s.maxFeeWei} wei`)) {
        throw new IpcError('USER_REJECTED', 'Signature refusée.');
      }
      const raw = '0x02' + bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(tx) + Math.random()))) + '00'.repeat(40);
      const hash = '0x' + demoHash(raw);
      chain.signedEvm.set(raw, { hash, tx, from: keys.accounts.evm.address });
      return { rawTx: raw, hash };
    },
    btc_sign_psbt: (a) => {
      requireUnlocked();
      checkPassword(a.password);
      const out = signPsbt(String(a.psbt ?? ''));
      const lines = out.summary.outputs.map(([ad, v, ch]) => `${ch ? '(monnaie) ' : ''}${ad} : ${v} sats`).join('\n');
      if (!confirmFn(`Signer cette transaction Bitcoin ?\n${lines}\nFrais : ${out.summary.feeSats} sats`)) throw new IpcError('USER_REJECTED', 'Signature refusée.');
      return out;
    },
    sol_decode_tx: (a) => {
      requireUnlocked();
      return demoDecodeSolMessage(decodeSolMessageArg(a.message), keys.accounts.sol.address);
    },
    sol_sign_tx: (a) => {
      requireUnlocked();
      const message = decodeSolMessageArg(a.message);
      const summary = demoDecodeSolMessage(message, keys.accounts.sol.address);
      if (summary.ourSignerIndex === null) throw new IpcError('INVALID_INPUT', 'Ce compte ne signe pas cette transaction.');
      checkPassword(a.password);
      if (!confirmFn(`Signer cette transaction Solana ?
${demoSolSummaryText(summary)}`)) throw new IpcError('USER_REJECTED', 'Signature refusée.');
      if (summary.requiresExtraConfirmation && !confirmFn(`Instruction non reconnue ou inhabituelle : signer quand même ?
${summary.warnings.map((w) => w.kind).join(', ')}`)) {
        throw new IpcError('USER_REJECTED', 'Signature refusée.');
      }
      const sig = new Uint8Array(64);
      sig.set(sha256(message), 0);
      sig.set(sha256(sha256(message)), 32);
      return { signature: base64.encode(sig), summary };
    },
    net_fetch: async (a) => {
      // Fail closed, like net.rs: over Tor only when enabled, never retried in clear.
      if (settings.tor.enabled) await tor.waitReady();
      return handleDemoNet(a.req as Parameters<typeof handleDemoNet>[0], chain);
    },
    tor_status: () => tor.status(),
    tor_retry: () => {
      if (!settings.tor.enabled) throw new IpcError('INVALID_INPUT', 'Tor est désactivé dans les réglages.');
      tor.restart();
      return tor.status();
    },
    settings_get: () => structuredClone(settings),
    settings_set: (a) => {
      const next = a.settings as Settings | undefined;
      if (!next || (next.currency !== 'EUR' && next.currency !== 'USD')) throw new IpcError('INVALID_INPUT', 'Réglages invalides.');
      if (!Number.isInteger(next.autoLockSecs) || next.autoLockSecs < 60 || next.autoLockSecs > 4 * 3600) {
        throw new IpcError('INVALID_INPUT', 'Délai de verrouillage invalide (1 min à 4 h).');
      }
      for (const url of Object.values(next.rpc)) {
        if (url !== undefined && url !== '' && !/^https:\/\//.test(url)) throw new IpcError('INVALID_INPUT', 'Les nœuds RPC doivent être en HTTPS.');
      }
      const torIn: unknown = (next as { tor?: unknown }).tor;
      if (torIn !== undefined && (typeof torIn !== 'object' || torIn === null || typeof (torIn as { enabled?: unknown }).enabled !== 'boolean')) {
        throw new IpcError('INVALID_INPUT', 'Réglages invalides (tor).');
      }
      const wasEnabled = settings.tor.enabled;
      // Missing `tor` → default (enabled), like serde's `#[serde(default)]`.
      settings = { ...structuredClone(next), tor: { enabled: torIn === undefined ? true : (torIn as { enabled: boolean }).enabled } };
      if (!wasEnabled && settings.tor.enabled) tor.start();
      if (wasEnabled && !settings.tor.enabled) tor.stop();
      return structuredClone(settings);
    },
    set_capture_protection: (a) => {
      captureProtected = Boolean(a.enabled);
    },
    config_get: (): AppConfig => ({ network, hasZeroxKey: true, hasOneinchKey: true, hasCoingeckoKey: false }),
  };

  return {
    chain,
    tor,
    advance(ms: number) {
      clockOffset += ms;
    },
    invoke: async (cmd, args = {}) => {
      const h = (handlers as Record<string, ((a: Record<string, unknown>) => unknown) | undefined>)[cmd];
      if (!h) throw new IpcError('INVALID_INPUT', `Commande inconnue : ${cmd}`);
      void captureProtected;
      return await h(args);
    },
  };
}

function decodeSolMessageArg(m: unknown): Uint8Array {
  try {
    const bytes = base64.decode(String(m ?? ''));
    if (bytes.length === 0) throw new Error('vide');
    return bytes;
  } catch {
    throw new IpcError('INVALID_INPUT', 'Message Solana invalide (base64 attendu).');
  }
}

function detectDemoNetwork(): Network {
  try {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('network') === 'mainnet') return 'mainnet';
  } catch {
    /* ignore */
  }
  return 'testnet';
}

let singleton: MockBackend | null = null;
export function getMockBackend(): MockBackend {
  singleton ??= createMockBackend();
  return singleton;
}
