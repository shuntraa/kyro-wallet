// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — simulated Ledger / Trezor, mirroring apps/desktop/src-tauri/src/commands_hw.rs
// and hw/*. The "device" keys come from a hard-coded public seed: they protect nothing.
//
// Scenario: `?hw=…` in the demo URL (or `MockOptions.hw` in tests):
//   none (default)  no device plugged in
//   ledger          Ledger Nano S Plus, « Bitcoin Test » open (Ethereum / Solana to open)
//   trezor          Trezor Safe 5: PIN typed on the device (`pin-on-device`)
//   trezor-one      Trezor One: blind PIN matrix (`pin-matrix` → hw_pin_matrix), no Solana
//   trezor-one-passphrase  Trezor One with a passphrase (typed on the computer: refused)
//   locked          Ledger locked (unlocked "by the user" after the first HW_LOCKED)
//   wrongapp        Ledger on the dashboard (the expected app is "opened" after HW_WRONG_APP)
//   reject          the user refuses on the device (HW_REJECTED)
//   unplug          unplugged in the middle of the signature (HW_DISCONNECTED)
//   mismatch        the device shows another address (HW_ADDRESS_MISMATCH)
//   timeout         no answer on the device (HW_TIMEOUT)
//   old             Trezor One firmware 1.9.0, too old (HW_UNSUPPORTED, min 1.10.4)
//   safe7           Trezor Safe 7 (THP), never paired: hw_open asks to allow « Kyro Wallet », shows a
//                   6-digit code (demo: `demoThpCode()`), checks it (HW_PAIRING_FAILED if wrong), then
//                   confirms the connection; any other command before that: HW_PAIRING_REQUIRED
//   safe7-paired    Trezor Safe 7 already paired: hw_open only asks to confirm the connection
// A wrong app or a locked device is "fixed" by the simulated user right after the error, so
// « Réessayer » works, as on a real device once the user opened the app / unlocked it.

import { HDKey } from '@scure/bip32';
import { base58, base64 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import {
  IpcError,
  type BtcKind,
  type BtcTxSummary,
  type EvmTxRequest,
  type EvmTxSummary,
  type HwChain,
  type HwChainStatus,
  type HwDeviceInfo,
  type HwDeviceStatus,
  type HwPrompt,
  type HwXpub,
  type Network,
  type SolTxSummary,
  type WatchOnlyAccount,
} from './ipc';
import { emitDemoEvent } from './events';
import { btcWarnings } from './warnings';
import { demoVsize } from './mock-tx';
import { demoDecodeSolMessage, demoSolSummaryText } from './mock-sol';

bitcoin.initEccLib(ecc);

export type DemoHwScenario = 'none' | 'ledger' | 'trezor' | 'trezor-one' | 'trezor-one-passphrase' | 'locked' | 'wrongapp' | 'reject' | 'unplug' | 'mismatch' | 'timeout' | 'old' | 'safe7' | 'safe7-paired';
const SCENARIOS: DemoHwScenario[] = ['none', 'ledger', 'trezor', 'trezor-one', 'trezor-one-passphrase', 'locked', 'wrongapp', 'reject', 'unplug', 'mismatch', 'timeout', 'old', 'safe7', 'safe7-paired'];

/** DEMO ONLY: the code the simulated Safe 7 « shows on its screen » for the current pairing attempt. */
let thpCodeOnDevice: string | null = null;
export function demoThpCode(): string | null {
  return thpCodeOnDevice;
}
const DEMO_THP_KEY = 'a3f9c27e51d84b0f6e2c9a7d31b58e04f6a2d9c17e3b85f04a6c2e9d17b3f58a';

/** Simulated device delays (1–3 s). Tests use fake timers. */
export const DEMO_HW_DELAYS = { list: 800, open: 1000, keys: 1500, verify: 2000, sign: 2500, unplugAfter: 1200, timeoutAfter: 3000 };

/** Demo Trezor One PIN and the scrambled layout its "screen" shows (rows top to bottom). */
export const DEMO_TREZOR_PIN = '1234';
export const DEMO_TREZOR_LAYOUT: number[][] = [
  [3, 8, 1],
  [6, 2, 9],
  [4, 7, 5],
];

/**
 * Trezor protocol: a PinMatrixAck position is a digit laid out like a numeric KEYPAD —
 * 7 8 9 on the top row, 4 5 6 in the middle, 1 2 3 at the bottom (trezorlib, firmware).
 * Rust forwards the positions verbatim (hw/trezor.rs: `ack.set_pin(positions)`).
 */
export const TREZOR_KEYPAD: string[][] = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
];

/** What the device does with positions: digit under each keypad position. */
export function demoDecodePin(positions: string): string {
  return [...positions]
    .map((p) => {
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (TREZOR_KEYPAD[r]?.[c] === p) return String(DEMO_TREZOR_LAYOUT[r]?.[c]);
      return '?';
    })
    .join('');
}

export function detectDemoHwScenario(): DemoHwScenario {
  try {
    const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('hw') : null;
    if (q && (SCENARIOS as string[]).includes(q)) return q as DemoHwScenario;
  } catch {
    /* ignore */
  }
  return 'none';
}

const TESTNET_VERSIONS = { private: 0x04358394, public: 0x043587cf };

function hwSeed(): Uint8Array {
  const a = sha256(new TextEncoder().encode('kyro-demo-hardware-wallet-public-do-not-use'));
  const out = new Uint8Array(64);
  out.set(a, 0);
  out.set(sha256(a), 32);
  return out;
}

function checksum(addrHexNo0x: string): string {
  const lower = addrHexNo0x.toLowerCase();
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) out += parseInt(hash[i] ?? '0', 16) >= 8 ? (lower[i] ?? '').toUpperCase() : (lower[i] ?? '');
  return out;
}

function evmAddressFromNode(node: HDKey, index: number): string {
  const pk = node.deriveChild(index).publicKey;
  if (!pk) throw new IpcError('INTERNAL', 'dérivation EVM');
  return checksum(bytesToHex(keccak_256(ecc.pointCompress(pk, false).slice(1))).slice(-40));
}

function btcAddress(xpub: string, network: Network, kind: BtcKind, change: number, index: number): string {
  const key = HDKey.fromExtendedKey(xpub, network === 'testnet' ? TESTNET_VERSIONS : undefined).deriveChild(change).deriveChild(index);
  const pk = key.publicKey;
  if (!pk) throw new IpcError('INTERNAL', 'dérivation BTC');
  const net = network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const p = kind === 'segwit' ? bitcoin.payments.p2wpkh({ pubkey: pk, network: net }) : bitcoin.payments.p2tr({ internalPubkey: pk.slice(1, 33), network: net });
  if (!p.address) throw new IpcError('INTERNAL', 'adresse');
  return p.address;
}

export interface DemoHwDeps {
  network: Network;
  /** LOCKED when a vault exists on this computer and is locked. */
  guard: () => void;
  /** Emulates Kyro's native dialog. */
  confirm: (text: string) => boolean;
  decodeEvm: (tx: EvmTxRequest) => EvmTxSummary;
  /** Signed EVM transactions known to the fake chain (so the broadcast works). */
  registerEvm: (raw: string, hash: string, tx: EvmTxRequest, from: string) => void;
  /** Gives the new hardware-wallet addresses some demo funds. */
  fund: (acc: WatchOnlyAccount, addresses: { taproot?: string; segwit?: string; evm?: string }) => void;
}

const LEDGER_CLEAR: Array<[number, string]> = [
  [1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
  [1, '0xdac17f958d2ee523a2206206994597c13d831ec7'],
  [11155111, '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'],
];

const PHASE4: HwChain[] = ['ltc', 'doge', 'tron', 'cardano', 'xrp'];
const LABEL: Record<HwChain, string> = { btc: 'Bitcoin', evm: 'EVM', sol: 'Solana', ltc: 'Litecoin', doge: 'Dogecoin', tron: 'TRON', cardano: 'Cardano', xrp: 'XRP' };

export function createDemoHw(scenario: DemoHwScenario, d: DemoHwDeps) {
  const seed = hwSeed();
  const testnet = d.network === 'testnet';
  const master = HDKey.fromMasterSeed(seed, testnet ? TESTNET_VERSIONS : undefined);
  const fingerprint = master.fingerprint.toString(16).padStart(8, '0');
  const evmNode = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0");

  const safe7 = scenario === 'safe7' || scenario === 'safe7-paired';
  const ledger = !scenario.startsWith('trezor') && scenario !== 'old' && !safe7;
  const one = scenario === 'trezor-one' || scenario === 'trezor-one-passphrase' || scenario === 'old';
  const device: HwDeviceInfo | null =
    scenario === 'none' ? null : ledger ? { id: 'ledger-1', kind: 'ledger', model: 'Ledger Nano S Plus', transport: 'hid' } : { id: 'trezor-1', kind: 'trezor', model: safe7 ? 'Trezor' : one ? 'Trezor One' : 'Trezor Safe 5', transport: 'webusb' };
  // Safe 7: listed as « Trezor » (same USB id), the real model comes from hw_open (THP).
  /** THP pairings of this installation (`trezor-thp.json`). */
  let thpPairings: Array<{ key: string; model: string; added: number }> = scenario === 'safe7-paired' ? [{ key: DEMO_THP_KEY, model: 'T3W1', added: Math.floor(Date.now() / 1000) - 86_400 }] : [];
  /** The THP channel is open (pairing + connection done this session). */
  let thpConnected = false;
  let thpCodeWaiter: ((code: string) => void) | null = null;
  const firmware = scenario === 'old' ? '1.9.0' : one ? '1.12.1' : safe7 ? '2.9.3' : '2.8.7';

  let locked = scenario === 'locked';
  let openApp = scenario === 'wrongapp' ? 'Tableau de bord' : testnet ? 'Bitcoin Test' : 'Bitcoin';
  /** Trezor: the PIN was entered this session. */
  let pinOk = false;
  let pinWaiter: ((positions: string) => void) | null = null;
  let pending: { cancel: () => void } | null = null;
  let accounts: WatchOnlyAccount[] = [];
  let nextId = 1;

  const appFor = (chain: HwChain) => (chain === 'btc' ? (testnet ? 'Bitcoin Test' : 'Bitcoin') : chain === 'evm' ? 'Ethereum' : 'Solana');

  const cancelled = () => new IpcError('USER_REJECTED', 'Action annulée.');

  /** Runs one device operation (one per device: HW_BUSY otherwise), cancellable. */
  const run = async <T>(id: string, op: (wait: (ms: number) => Promise<void>) => Promise<T>): Promise<T> => {
    if (!device || id !== device.id) throw new IpcError('HW_NOT_FOUND', 'Appareil introuvable : branche-le, déverrouille-le, puis relance la détection.');
    if (pending) throw new IpcError('HW_BUSY', 'Appareil occupé : une autre opération est en cours sur cet appareil.');
    let rejectCurrent: ((e: unknown) => void) | null = null;
    let isCancelled = false;
    pending = {
      cancel: () => {
        isCancelled = true;
        rejectCurrent?.(cancelled());
      },
    };
    const wait = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        if (isCancelled) return reject(cancelled());
        const t = setTimeout(() => {
          rejectCurrent = null;
          resolve();
        }, ms);
        rejectCurrent = (e) => {
          clearTimeout(t);
          reject(e);
        };
      });
    try {
      return await op(wait);
    } finally {
      pending = null;
      pinWaiter = null;
      thpCodeWaiter = null;
      thpCodeOnDevice = null;
    }
  };

  /** Safe 7: every command but hw_open needs the paired THP channel. */
  const requirePaired = () => {
    if (safe7 && (!thpConnected || !thpPairings.some((p) => p.key === DEMO_THP_KEY))) {
      thpConnected = false;
      throw new IpcError('HW_PAIRING_REQUIRED', 'Appairage requis : ce Trezor Safe 7 n’est pas (ou plus) appairé avec Kyro. Connecte-le d’abord (hw_open).');
    }
  };

  /** Safe 7 THP: pairing by code (first time) then connection confirmation. */
  const connectThp = async (wait: (ms: number) => Promise<void>) => {
    if (!safe7 || thpConnected) return;
    if (!thpPairings.some((p) => p.key === DEMO_THP_KEY)) {
      prompt('thp-confirm-pairing');
      await wait(1500);
      thpCodeOnDevice = String(Math.floor(100_000 + Math.random() * 900_000));
      prompt('thp-pairing-code');
      const box: { code: string | null } = { code: null };
      thpCodeWaiter = (c) => {
        box.code = c;
      };
      // 180 s, polled in 100 ms slices (cancellable: hw_cancel → USER_REJECTED).
      for (let i = 0; box.code === null; i++) {
        if (i >= 1800) throw new IpcError('HW_TIMEOUT', 'Délai dépassé : pas de réponse de l’appareil à temps. Opération abandonnée.');
        await wait(100);
      }
      thpCodeWaiter = null;
      const ok = box.code === thpCodeOnDevice;
      thpCodeOnDevice = null;
      if (!ok) throw new IpcError('HW_PAIRING_FAILED', 'Appairage échoué : code incorrect. Relance la connexion : l’appareil affichera un nouveau code.');
      thpPairings = [...thpPairings, { key: DEMO_THP_KEY, model: 'T3W1', added: Math.floor(Date.now() / 1000) }];
    }
    prompt('thp-confirm-connection');
    await wait(1200);
    thpConnected = true;
  };

  const prompt = (kind: HwPrompt['kind']) => {
    if (device) emitDemoEvent('hw-prompt', { id: device.id, kind });
  };

  /** Trezor PIN: on the device (T / Safe) or the blind matrix (One). */
  const unlockTrezor = async (wait: (ms: number) => Promise<void>) => {
    if (ledger || pinOk) return;
    if (!one) {
      prompt('pin-on-device');
      await wait(1500);
      pinOk = true;
      return;
    }
    prompt('pin-matrix');
    // Polls in 100 ms slices like the Rust transports (cancellable), 90 s read deadline.
    const box: { positions: string | null } = { positions: null };
    pinWaiter = (p) => {
      box.positions = p;
    };
    for (let i = 0; box.positions === null; i++) {
      if (i >= 900) throw new IpcError('HW_TIMEOUT', 'Délai dépassé : pas de réponse de l’appareil à temps. Opération abandonnée.');
      await wait(100);
    }
    pinWaiter = null;
    if (demoDecodePin(box.positions) !== DEMO_TREZOR_PIN) throw new IpcError('HW_LOCKED', 'Appareil verrouillé : PIN incorrect.');
    pinOk = true;
    if (scenario === 'trezor-one-passphrase') {
      throw new IpcError('HW_UNSUPPORTED', 'Non pris en charge : passphrase de la Trezor One (elle se tape sur l’ordinateur, ce que Kyro refuse)', { min: null });
    }
  };

  /** The device must be usable for `chain` (unlocked, right app / firmware). */
  const ensure = async (chain: HwChain, wait: (ms: number) => Promise<void>) => {
    if (PHASE4.includes(chain)) throw new IpcError('HW_UNSUPPORTED', `Non pris en charge : ${LABEL[chain]} : pas encore pris en charge par Kyro (phase 4)`, { min: null });
    if (ledger) {
      if (locked) {
        locked = false; // the simulated user unlocks it now
        throw new IpcError('HW_LOCKED', 'Appareil verrouillé : déverrouille-le avec ton code PIN, puis réessaie.');
      }
      const expected = appFor(chain);
      if (openApp !== expected) {
        const open = openApp;
        openApp = expected; // the simulated user opens it now
        throw new IpcError('HW_WRONG_APP', `Mauvaise application ouverte sur l’appareil : ouvre « ${expected} » (ouverte : « ${open} »).`, { expected, open });
      }
      return;
    }
    if (scenario === 'old' && chain !== 'sol') throw new IpcError('HW_UNSUPPORTED', 'Non pris en charge : firmware Trezor One 1.9.0 trop ancien', { min: '1.10.4' });
    if (one && chain === 'sol') throw new IpcError('HW_UNSUPPORTED', 'Non pris en charge : Solana n’existe pas sur la Trezor One', { min: null });
    await unlockTrezor(wait);
  };

  const status = (): HwDeviceStatus => {
    if (!device) throw new IpcError('HW_NOT_FOUND', 'Appareil introuvable.');
    const chain = (c: HwChain): HwChainStatus => {
      if (PHASE4.includes(c)) return { chain: c, state: 'unsupported', reason: `${LABEL[c]} : pas encore pris en charge par Kyro (phase 4)` };
      if (ledger) {
        if (locked) return { chain: c, state: 'unlock' };
        return openApp === appFor(c) ? { chain: c, state: 'ready', app: appFor(c) } : { chain: c, state: 'open-app', app: appFor(c), min: c === 'btc' ? '2.1.0' : c === 'evm' ? '1.9.0' : '1.3.1' };
      }
      if (one && c === 'sol') return { chain: c, state: 'unsupported', reason: 'Solana : pas sur la Trezor One' };
      if (scenario === 'old') return { chain: c, state: 'unsupported', min: '1.10.4', reason: 'firmware trop ancien' };
      return { chain: c, state: pinOk ? 'ready' : 'unlock' };
    };
    const st: HwDeviceStatus = { id: device.id, kind: device.kind, model: safe7 ? 'Trezor Safe 7' : device.model, locked: ledger ? locked : !pinOk, chains: (['btc', 'evm', 'sol', ...PHASE4] as HwChain[]).map(chain) };
    if (safe7) st.protocol = 'thp';
    if (ledger) st.app = { name: openApp, version: openApp === 'Tableau de bord' ? '' : '2.2.4' };
    else {
      st.firmware = firmware;
      st.passphrase = scenario === 'trezor-one-passphrase';
    }
    return st;
  };

  const keysFor = (chain: HwChain, account: number): HwXpub => {
    const out: HwXpub = { chain, account };
    const coin = testnet ? 1 : 0;
    if (chain === 'btc') {
      out.btc = (['segwit', 'taproot'] as const).map((kind) => {
        const path = `m/${kind === 'segwit' ? 84 : 86}'/${coin}'/${account}'`;
        return { kind, xpub: master.derive(path).publicExtendedKey, fingerprint, path };
      });
    }
    if (chain === 'evm') out.evm = { xpub: evmNode.publicExtendedKey, path: "m/44'/60'/0'/0", address: evmAddressFromNode(evmNode, account) };
    if (chain === 'sol') out.sol = { address: base58.encode(sha256(new TextEncoder().encode(`kyro-demo-hw-sol:${account}`))), path: `m/44'/501'/${account}'/0'` };
    return out;
  };

  const readKeys = async (id: string, chain: HwChain, account: number): Promise<HwXpub> => {
    if (!Number.isInteger(account) || account < 0 || account > 100) throw new IpcError('INVALID_INPUT', 'Entrée invalide : numéro de compte : 0 à 100');
    return run(id, async (wait) => {
      requirePaired();
      await ensure(chain, wait);
      await wait(DEMO_HW_DELAYS.keys);
      return keysFor(chain, account);
    });
  };

  const find = (accountId: unknown): WatchOnlyAccount => {
    const a = accounts.find((x) => x.id === accountId);
    if (!a) throw new IpcError('INVALID_INPUT', 'Entrée invalide : compte hardware wallet inconnu');
    return a;
  };

  const checkBrand = (acc: WatchOnlyAccount) => {
    if (!device || device.kind !== acc.device) throw new IpcError('HW_WRONG_DEVICE', 'Ce n’est pas l’appareil de ce compte (clés différentes).');
  };

  /** Re-reads the keys (`same_device`): this demo device always holds the demo seed. */
  const sameDevice = async (acc: WatchOnlyAccount, chain: HwChain, wait: (ms: number) => Promise<void>) => {
    await ensure(chain, wait);
    await wait(600);
    if (chain === 'btc' && acc.btc?.[0]?.fingerprint !== fingerprint) throw new IpcError('HW_WRONG_DEVICE', 'Ce n’est pas l’appareil de ce compte (clés différentes).');
  };

  const deviceLine = () => `\n\n— Appareil : ${device?.model} —\nAprès « Signer », vérifie les MÊMES informations sur l’écran de l’appareil et confirme-les là-bas.`;

  /** Waiting for the user's confirmation on the device, with the failure scenarios. */
  const onDevice = async (wait: (ms: number) => Promise<void>) => {
    prompt('confirm-on-device');
    if (scenario === 'unplug') {
      await wait(DEMO_HW_DELAYS.unplugAfter);
      throw new IpcError('HW_DISCONNECTED', 'Appareil débranché ou injoignable : opération abandonnée, rien n’a été signé.');
    }
    if (scenario === 'timeout') {
      await wait(DEMO_HW_DELAYS.timeoutAfter);
      throw new IpcError('HW_TIMEOUT', 'Délai dépassé : pas de réponse de l’appareil à temps. Opération abandonnée.');
    }
    await wait(DEMO_HW_DELAYS.sign);
    if (scenario === 'reject') throw new IpcError('HW_REJECTED', 'Refusé sur l’appareil.');
  };

  const ownBtc = (acc: WatchOnlyAccount): Set<string> => {
    const out = new Set<string>();
    for (const b of acc.btc ?? []) for (const ch of [0, 1]) for (let i = 0; i < 20; i++) out.add(btcAddress(b.xpub, acc.network, b.kind, ch, i));
    return out;
  };

  const resolvePath = (acc: WatchOnlyAccount, chain: HwChain, path: string): string => {
    const wrong = () => new IpcError('INVALID_INPUT', 'Entrée invalide : ce chemin n’appartient pas à ce compte hardware wallet');
    if (chain === 'btc') {
      const m = /^(m\/(84|86)'\/[01]'\/\d+')\/([01])\/(\d+)$/.exec(path.trim());
      if (!m) throw wrong();
      const b = acc.btc?.find((x) => x.path === m[1]);
      if (!b) throw wrong();
      return btcAddress(b.xpub, acc.network, b.kind, Number(m[3]), Number(m[4]));
    }
    if (chain === 'evm') {
      const m = /^m\/44'\/60'\/0'\/0\/(\d+)$/.exec(path.trim());
      if (!m || !acc.evm) throw wrong();
      return evmAddressFromNode(HDKey.fromExtendedKey(acc.evm.xpub), Number(m[1]));
    }
    if (chain === 'sol') {
      if (!acc.sol || acc.sol.path !== path.trim()) throw wrong();
      return acc.sol.address;
    }
    throw new IpcError('HW_UNSUPPORTED', `Non pris en charge : ${LABEL[chain]} (phase 4)`, { min: null });
  };

  return {
    scenario,
    async list(): Promise<HwDeviceInfo[]> {
      await new Promise((r) => setTimeout(r, DEMO_HW_DELAYS.list));
      return device ? [{ ...device }] : [];
    },
    open: (id: unknown) =>
      run(String(id), async (wait) => {
        await wait(DEMO_HW_DELAYS.open);
        await connectThp(wait);
        if (!ledger && !pinOk && scenario !== 'old') {
          // Reading the Trezor state may ask for the PIN.
          await unlockTrezor(wait);
        }
        return status();
      }),
    cancel(id: unknown): boolean {
      if (!device || id !== device.id) throw new IpcError('HW_NOT_FOUND', 'Appareil introuvable.');
      if (!pending) return false;
      pending.cancel();
      return true;
    },
    thpPairingCode(id: unknown, code: unknown) {
      const c = String(code ?? '');
      if (!/^[0-9]{6}$/.test(c)) throw new IpcError('INVALID_INPUT', 'Entrée invalide : code d’appairage : 6 chiffres');
      if (!device || id !== device.id || !thpCodeWaiter) throw new IpcError('HW_BAD_RESPONSE', 'Réponse de l’appareil refusée par Kyro : aucun appairage en attente');
      thpCodeWaiter(c);
    },
    thpPairings: () => structuredClone(thpPairings),
    thpForget(key: unknown): number {
      d.guard();
      const before = thpPairings.length;
      thpPairings = typeof key === 'string' ? thpPairings.filter((p) => p.key !== key) : [];
      thpConnected = false;
      return before - thpPairings.length;
    },
    pinMatrix(id: unknown, positions: unknown) {
      const p = String(positions ?? '');
      if (!p || p.length > 50 || !/^[1-9]+$/.test(p)) throw new IpcError('INVALID_INPUT', 'Entrée invalide : positions : chiffres 1 à 9');
      if (!device || id !== device.id || !pinWaiter) throw new IpcError('HW_BAD_RESPONSE', 'Réponse de l’appareil refusée par Kyro : aucune saisie de PIN en attente');
      pinWaiter(p);
    },
    getXpub(a: Record<string, unknown>) {
      d.guard();
      return readKeys(String(a.id), a.chain as HwChain, Number(a.account));
    },
    accountsGet: (): WatchOnlyAccount[] => structuredClone(accounts),
    async accountAdd(a: Record<string, unknown>): Promise<WatchOnlyAccount> {
      d.guard();
      const chain = a.chain as HwChain;
      const account = Number(a.account);
      if (!device || a.id !== device.id) throw new IpcError('HW_NOT_FOUND', 'Appareil introuvable.');
      const keys = await readKeys(String(a.id), chain, account);
      let acc: WatchOnlyAccount;
      if (typeof a.accountId === 'string') {
        acc = structuredClone(find(a.accountId));
        checkBrand(acc);
        if (acc.account !== account) throw new IpcError('INVALID_INPUT', 'Entrée invalide : numéro de compte différent de celui du compte existant');
      } else {
        acc = { id: `hw-${(0xa1b2c3d400000000n + BigInt(nextId++)).toString(16).padStart(16, '0')}`, label: '', device: device.kind, model: device.model, network: d.network, account };
      }
      if (typeof a.label === 'string') acc.label = a.label.trim();
      if (!acc.label) acc.label = `${device.model} ${account + 1}`;
      if (keys.btc) {
        if (acc.btc?.[0] && acc.btc[0].fingerprint !== keys.btc[0]?.fingerprint) throw new IpcError('HW_WRONG_DEVICE', 'Ce n’est pas l’appareil de ce compte (clés différentes).');
        acc.btc = keys.btc;
      }
      if (keys.evm) acc.evm = { xpub: keys.evm.xpub, path: keys.evm.path };
      if (keys.sol) acc.sol = { ...keys.sol };
      accounts = [...accounts.filter((x) => x.id !== acc.id), acc];
      const tap = acc.btc?.find((b) => b.kind === 'taproot');
      const seg = acc.btc?.find((b) => b.kind === 'segwit');
      d.fund(acc, {
        ...(tap ? { taproot: btcAddress(tap.xpub, acc.network, 'taproot', 0, 0) } : {}),
        ...(seg ? { segwit: btcAddress(seg.xpub, acc.network, 'segwit', 0, 0) } : {}),
        ...(keys.evm ? { evm: keys.evm.address } : {}),
      });
      return structuredClone(acc);
    },
    accountRemove(accountId: unknown) {
      d.guard();
      find(accountId);
      accounts = accounts.filter((x) => x.id !== accountId);
    },
    async verifyAddress(a: Record<string, unknown>) {
      d.guard();
      const acc = find(a.accountId);
      checkBrand(acc);
      const chain = a.chain as HwChain;
      const path = String(a.path ?? '');
      const expected = resolvePath(acc, chain, path);
      return run(String(a.id), async (wait) => {
        requirePaired();
        await sameDevice(acc, chain, wait);
        await onDevice(wait);
        if (scenario === 'mismatch') {
          const shown = chain === 'evm' ? evmAddressFromNode(evmNode, acc.account + 7) : chain === 'btc' ? btcAddress(acc.btc![0]!.xpub, acc.network, acc.btc![0]!.kind, 0, 99) : base58.encode(sha256(new TextEncoder().encode('attacker')));
          throw new IpcError('HW_ADDRESS_MISMATCH', `ADRESSES DIFFÉRENTES : l’appareil donne ${shown}, Kyro attendait ${expected}. N’utilise pas cette adresse.`, { device: shown, expected });
        }
        return { address: expected, path: path.trim() };
      });
    },
    async signBtc(a: Record<string, unknown>): Promise<{ psbt: string; summary: BtcTxSummary }> {
      d.guard();
      const acc = find(a.accountId);
      checkBrand(acc);
      if (!acc.btc?.length) throw new IpcError('INVALID_INPUT', 'Entrée invalide : ce compte n’a pas de clés Bitcoin');
      const net = testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
      let psbt: bitcoin.Psbt;
      try {
        psbt = bitcoin.Psbt.fromBase64(String(a.psbt ?? ''), { network: net });
      } catch {
        throw new IpcError('INVALID_INPUT', 'Entrée invalide : PSBT invalide');
      }
      const kinds = new Set<BtcKind>();
      psbt.data.inputs.forEach((input, i) => {
        const tap = (input.tapBip32Derivation?.length ?? 0) > 0;
        const seg = (input.bip32Derivation?.length ?? 0) > 0;
        if (!input.witnessUtxo || (!tap && !seg)) throw new IpcError('HW_UNSUPPORTED', 'Non pris en charge : transaction avec des entrées qui n’appartiennent pas à ce compte', { min: null });
        if (seg && !input.nonWitnessUtxo) {
          throw new IpcError('INVALID_INPUT', `Entrée invalide : la PSBT doit inclure la transaction précédente (non_witness_utxo) de l’entrée ${i} pour une signature sur hardware wallet`);
        }
        kinds.add(tap ? 'taproot' : 'segwit');
      });
      if (ledger && kinds.size > 1) throw new IpcError('HW_UNSUPPORTED', 'Non pris en charge : entrées SegWit et Taproot mélangées (Ledger)', { min: null });
      const own = ownBtc(acc);
      let inSum = 0n;
      psbt.data.inputs.forEach((i) => (inSum += i.witnessUtxo?.value ?? 0n));
      const outputs = psbt.txOutputs.map((o) => {
        const address = o.address ?? bitcoin.address.fromOutputScript(o.script, net);
        return [address, Number(o.value), own.has(address)] as [string, number, boolean];
      });
      const feeSats = Number(inSum - psbt.txOutputs.reduce((s, o) => s + o.value, 0n));
      const summary: BtcTxSummary = { outputs, feeSats, ...btcWarnings({ outputs, feeSats, vsize: demoVsize(psbt) }) };
      return run(String(a.id), async (wait) => {
        requirePaired();
        await sameDevice(acc, 'btc', wait);
        const lines = outputs.map(([ad, v, ch]) => `${ch ? '(monnaie) ' : ''}${ad} : ${v} sats`).join('\n');
        if (!d.confirm(`Confirmer la transaction (hardware wallet)\n${lines}\nFrais : ${summary.feeSats} sats${deviceLine()}`)) throw new IpcError('USER_REJECTED', 'Action annulée.');
        await onDevice(wait);
        psbt.data.inputs.forEach((input, i) => {
          const h = sha256(new TextEncoder().encode(`hw:${i}:${a.psbt}`));
          if (input.tapBip32Derivation?.length) {
            const tapKeySig = new Uint8Array(64);
            tapKeySig.set(h, 0);
            tapKeySig.set(sha256(h), 32);
            psbt.updateInput(i, { tapKeySig });
          } else {
            const r = h.slice();
            const s = sha256(h);
            r[0] = ((r[0] ?? 0) & 0x3f) | 0x01;
            s[0] = ((s[0] ?? 0) & 0x3f) | 0x01;
            psbt.updateInput(i, { partialSig: [{ pubkey: input.bip32Derivation![0]!.pubkey, signature: new Uint8Array([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s, 0x01]) }] });
          }
        });
        return { psbt: psbt.toBase64(), summary };
      });
    },
    async signEvm(a: Record<string, unknown>): Promise<{ rawTx: string; hash: string }> {
      d.guard();
      const acc = find(a.accountId);
      checkBrand(acc);
      if (!acc.evm) throw new IpcError('INVALID_INPUT', 'Entrée invalide : ce compte n’a pas de clé EVM');
      const tx = a.tx as EvmTxRequest;
      const s = d.decodeEvm(tx);
      const from = evmAddressFromNode(HDKey.fromExtendedKey(acc.evm.xpub), acc.account);
      const clear =
        s.kind === 'NativeTransfer' ||
        (!ledger && s.kind === 'Erc20Transfer') ||
        (ledger && (s.kind === 'Erc20Transfer' || s.kind === 'Erc20Approve') && LEDGER_CLEAR.some(([c, addr]) => c === tx.chainId && addr === s.tokenContract?.toLowerCase()));
      return run(String(a.id), async (wait) => {
        requirePaired();
        await sameDevice(acc, 'evm', wait);
        if (!d.confirm(`Confirmer la transaction (hardware wallet)\n${s.kind} vers ${s.to}\nMontant : ${s.amount}\nFrais max. : ${s.maxFeeWei} wei${deviceLine()}`)) throw new IpcError('USER_REJECTED', 'Action annulée.');
        if (!clear || s.kind === 'ContractCall') {
          if (!d.confirm('Attention : vérification limitée\nTon appareil ne pourra PAS afficher le détail de cette transaction (blind signing). Seul le résumé de Kyro décrit ce que tu signes.')) throw new IpcError('USER_REJECTED', 'Action annulée.');
        }
        await onDevice(wait);
        const raw = '0x02' + bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(tx) + Math.random()))) + '00'.repeat(40);
        const hash = '0x' + bytesToHex(sha256(new TextEncoder().encode(raw)));
        d.registerEvm(raw, hash, tx, from);
        return { rawTx: raw, hash };
      });
    },
    async signSol(a: Record<string, unknown>): Promise<{ signature: string; summary: SolTxSummary }> {
      d.guard();
      const acc = find(a.accountId);
      checkBrand(acc);
      if (!acc.sol) throw new IpcError('INVALID_INPUT', 'Entrée invalide : ce compte n’a pas de clé Solana');
      let message: Uint8Array;
      try {
        message = base64.decode(String(a.message ?? ''));
      } catch {
        throw new IpcError('INVALID_INPUT', 'Entrée invalide : message Solana invalide');
      }
      const summary = demoDecodeSolMessage(message, acc.sol.address);
      if (summary.ourSignerIndex === null) throw new IpcError('INVALID_INPUT', 'Entrée invalide : cette transaction ne demande pas la signature de cette adresse Solana');
      return run(String(a.id), async (wait) => {
        requirePaired();
        await sameDevice(acc, 'sol', wait);
        if (!d.confirm(`Confirmer la transaction Solana (hardware wallet)\n${demoSolSummaryText(summary)}${deviceLine()}`)) throw new IpcError('USER_REJECTED', 'Action annulée.');
        await onDevice(wait);
        const sig = new Uint8Array(64);
        sig.set(sha256(message), 0);
        sig.set(sha256(sha256(message)), 32);
        return { signature: base64.encode(sig), summary };
      });
    },
  };
}

export type DemoHw = ReturnType<typeof createDemoHw>;
