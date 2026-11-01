// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — Monero (`xmr_*`, docs/IPC.md §2.11), mirroring apps/desktop/src-tauri/src/
// commands_xmr.rs and xmr_backend.rs. The addresses are well-formed Monero addresses (network
// byte, two 32-byte "keys", Keccak-256 checksum, Monero base58) but their keys are NOT derived
// from the seed: the real mapping (BIP32 m/44'/128'/a'/0/0 → keccak → spend/view keys) lives in
// wallet-core only. Nothing is scanned or signed: the scan is a counter that advances on each
// poll, the transfer and its txid are fake. The rules are Rust's:
// - unlocked = outputs with ≥ 10 confirmations; balance = everything not spent;
// - `xmr_prepare_tx` refuses while the scan is incomplete, another network's address, an amount
//   above the unlocked balance + fee; `amount` absent = everything unlocked;
// - subaddresses are handed out one by one (`xmr_new_subaddress`), index 0 = primary address.
//
// Scenario words in a custom monerod URL: « down » → SERVER_UNREACHABLE, « wrong » →
// SERVER_WRONG_NETWORK.

import { base58xmr } from '@scure/base';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import {
  IpcError,
  type Commands,
  type MoneroServer,
  type Network,
  type ServerTestResult,
  type Settings,
  type XmrBackendInfo,
  type XmrDestination,
  type XmrHistoryEntry,
  type XmrStatus,
  type XmrSubaddress,
  type XmrTxSummary,
  type XmrWarning,
} from './ipc';
import { checkServerUrl } from './servers';
import { decimalMark, l10n } from './i18n';
import type { DemoTor } from './mock-tor';

const PICO = 1_000_000_000_000n;
/** Demo fee of a 2-output transfer (≈ 1 500 weight × 80 000 piconero). */
const FEE = 120_000_000n;
const CONFIRMATIONS = 10;
/** Blocks scanned per poll of the demo scan. */
const SCAN_STEP = 400;

/** Monero network bytes: [standard, integrated, subaddress]. */
const BYTES: Record<Network, [number, number, number]> = {
  mainnet: [18, 19, 42],
  testnet: [24, 25, 36], // stagenet
};

function encodeAddress(tag: number, spend: Uint8Array, view: Uint8Array, paymentId?: Uint8Array): string {
  const data = new Uint8Array([tag, ...spend, ...view, ...(paymentId ?? [])]);
  const sum = keccak_256(data).slice(0, 4);
  return base58xmr.encode(new Uint8Array([...data, ...sum]));
}

const keyOf = (label: string) => sha256(new TextEncoder().encode(label));

/** Demo address (well-formed, NOT derived): `index` 0 = primary, n = subaddress (0, n). */
export function demoXmrAddress(network: Network, account: number, index = 0): string {
  const [std, , sub] = BYTES[network];
  return encodeAddress(index === 0 ? std : sub, keyOf(`xmr-spend-${account}-${index}`), keyOf(`xmr-view-${account}-${index}`));
}

/** Demo integrated address of `account` with `paymentId` (8 bytes). */
export function demoXmrIntegrated(network: Network, account: number, paymentId: Uint8Array): string {
  return encodeAddress(BYTES[network][1], keyOf(`xmr-spend-${account}-0`), keyOf(`xmr-view-${account}-0`), paymentId);
}

const invalidInput = (m: string) => new IpcError('INVALID_INPUT', l10n(`Entrée invalide : ${m}`, `Invalid input: ${m}`));
const unreachable = (m: string) => new IpcError('SERVER_UNREACHABLE', l10n(`Serveur injoignable : ${m}`, `Server unreachable: ${m}`));
const has = (s: string, w: string) => s.toLowerCase().includes(w);
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};
export const xmrText = (pico: bigint | string) => {
  const v = BigInt(pico);
  const frac = (v % PICO).toString().padStart(12, '0').replace(/0+$/, '');
  return `${v / PICO}${frac ? `${decimalMark()}${frac}` : ''} XMR`;
};

/** wallet-core `xmr_parse_address`, demo: base58 + checksum + network byte (same messages). */
export function checkXmrAddress(address: unknown, network: Network): XmrDestination {
  const s = String(address ?? '').trim();
  let raw: Uint8Array;
  try {
    raw = base58xmr.decode(s);
  } catch {
    throw invalidInput(l10n('adresse Monero invalide (format ou somme de contrôle)', 'invalid Monero address (format or checksum)'));
  }
  if (raw.length !== 69 && raw.length !== 77) throw invalidInput(l10n('adresse Monero invalide (format ou somme de contrôle)', 'invalid Monero address (format or checksum)'));
  const body = raw.slice(0, raw.length - 4);
  const sum = keccak_256(body).slice(0, 4);
  if (!raw.slice(raw.length - 4).every((b, i) => b === sum[i])) throw invalidInput(l10n('adresse Monero invalide (format ou somme de contrôle)', 'invalid Monero address (format or checksum)'));
  const tag = body[0] ?? 0;
  const other: Network = network === 'mainnet' ? 'testnet' : 'mainnet';
  const name = (n: Network) => (n === 'mainnet' ? 'mainnet' : 'stagenet');
  if (BYTES[other].includes(tag)) throw invalidInput(l10n(`adresse Monero ${name(other)} : Kyro est sur ${name(network)}`, `Monero ${name(other)} address: Kyro is on ${name(network)}`));
  const [std, integ, sub] = BYTES[network];
  if (tag === std && raw.length === 69) return { address: s, kind: 'standard' };
  if (tag === sub && raw.length === 69) return { address: s, kind: 'subaddress' };
  if (tag === integ && raw.length === 77) return { address: s, kind: 'integrated', paymentId: bytesToHex(body.slice(65, 73)) };
  throw invalidInput(l10n('adresse Monero invalide (format ou somme de contrôle)', 'invalid Monero address (format or checksum)'));
}

export interface DemoXmrDeps {
  network: Network;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
  now: () => number;
}

interface DemoOutput {
  amount: bigint;
  height: number;
  subaddress: number;
  spent: boolean;
}

export interface DemoXmrState {
  me: string;
  /** A third party's subaddress to send to. */
  friend: string;
  tip: number;
  restoreHeight: number | null;
  scanned: number;
  running: boolean;
  subaddresses: number;
  outputs: DemoOutput[];
  history: XmrHistoryEntry[];
  pending: Map<string, { summary: XmrTxSummary; created: number }>;
}

export function createDemoXmr(d: DemoXmrDeps) {
  const netKey = d.network === 'mainnet' ? 'mainnet' : 'testnet';
  const me = demoXmrAddress(d.network, 0);
  const friend = encodeAddress(BYTES[d.network][2], keyOf('xmr-friend-spend'), keyOf('xmr-friend-view'));
  const t0 = d.now();
  const tip0 = d.network === 'mainnet' ? 3_796_640 : 2_241_120;
  const state: DemoXmrState = {
    me,
    friend,
    tip: tip0,
    restoreHeight: null,
    scanned: 0,
    running: false,
    subaddresses: 1,
    outputs: [],
    history: [],
    pending: new Map(),
  };
  // What a scan finds once it has gone past these heights.
  const found: Array<DemoOutput & { txid: string; time: number }> = [
    { amount: 2_400_000_000_000n, height: tip0 - 1_600, subaddress: 0, spent: false, txid: bytesToHex(keyOf('xmr-in-1')), time: Math.floor(t0 / 1000) - 3 * 86_400 },
    { amount: 350_000_000_000n, height: tip0 - 4, subaddress: 1, spent: false, txid: bytesToHex(keyOf('xmr-in-2')), time: Math.floor(t0 / 1000) - 480 },
  ];

  const torOn = () => d.settings().tor.enabled;
  const serverOf = (): MoneroServer => d.settings().servers.monero?.[netKey] ?? { kind: 'default' };
  const defaultHost = d.network === 'mainnet' ? 'xmr-node.cakewallet.com:18081' : 'monero-stagenet.stackwallet.com:38081';
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const accountOf = (a: Record<string, unknown>) => {
    const account = a.account === undefined ? 0 : Number(a.account);
    if (!Number.isInteger(account) || account < 0 || account > 100) throw invalidInput(l10n('numéro de compte : au plus 100', 'account number: at most 100'));
    return account;
  };

  /** Gate of every read: the right server, Tor, no fallback. A block every 2 min. */
  const backend = async () => {
    const s = serverOf();
    if (s.kind === 'node') {
      const bad = checkServerUrl(s.url, torOn());
      if (bad) throw new IpcError('SERVER_INVALID', l10n(`Serveur invalide : ${bad}`, `Invalid server: ${bad}`));
    }
    if (torOn()) await d.tor.waitReady();
    await wait(30 + Math.random() * 80);
    if (s.kind === 'node' && has(s.url, 'down')) throw unreachable(l10n(`${hostOf(s.url)} : délai de connexion dépassé`, `${hostOf(s.url)}: connection timed out`));
    state.tip = tip0 + Math.floor((d.now() - t0) / 120_000);
    return s;
  };

  /** One step of the demo scan (called by each `xmr_status` poll while running). */
  const step = () => {
    if (!state.running) return;
    if (state.restoreHeight === null) {
      state.restoreHeight = state.tip - 2_000;
      state.scanned = state.restoreHeight;
    }
    state.scanned = Math.min(state.tip, state.scanned + SCAN_STEP);
    for (const f of found) {
      if (f.height < state.scanned && f.height >= (state.restoreHeight ?? 0) && !state.history.some((h) => h.txid === f.txid)) {
        state.outputs.push({ amount: f.amount, height: f.height, subaddress: f.subaddress, spent: false });
        state.history.push({ txid: f.txid, direction: 'in', amount: f.amount.toString(), fee: null, to: null, height: f.height, time: f.time, confirmations: 0 });
      }
    }
    if (state.scanned >= state.tip) state.running = false;
  };

  const balances = () => {
    let total = 0n;
    let unlocked = 0n;
    for (const o of state.outputs.filter((x) => !x.spent)) {
      total += o.amount;
      if (state.tip >= o.height + CONFIRMATIONS) unlocked += o.amount;
    }
    return { total, unlocked };
  };

  const status = (): XmrStatus => {
    const { total, unlocked } = balances();
    const r = state.restoreHeight;
    const progress = r === null ? 0 : state.tip > r ? Math.min(1, (state.scanned - r) / (state.tip - r)) : 1;
    const s = serverOf();
    return {
      running: state.running,
      restoreHeight: r,
      scanned: state.scanned,
      tip: r === null && !state.running ? null : state.tip,
      tipTime: Math.floor(d.now() / 1000),
      progress,
      balance: total.toString(),
      unlocked: unlocked.toString(),
      syncedAt: r !== null && !state.running ? Math.floor(d.now() / 1000) : null,
      error: null,
      subaddresses: state.subaddresses,
      ignoredOutputs: 0,
      node: s.kind === 'node' ? hostOf(s.url) : defaultHost.split(':')[0] ?? defaultHost,
    };
  };

  const subaddressList = (account: number): XmrSubaddress[] =>
    Array.from({ length: state.subaddresses + 1 }, (_, index) => ({
      index,
      address: demoXmrAddress(d.network, account, index),
      received: (account === 0 ? state.outputs.filter((o) => o.subaddress === index).reduce((a, o) => a + o.amount, 0n) : 0n).toString(),
    }));

  const describe = (s: XmrTxSummary) => {
    const line = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    const kind = s.destination.kind === 'standard' ? l10n('adresse standard', 'standard address') : s.destination.kind === 'subaddress' ? l10n('sous-adresse', 'subaddress') : l10n(`adresse intégrée — ID de paiement ${s.destination.paymentId}`, `integrated address — payment ID ${s.destination.paymentId}`);
    return (
      l10n(`Envoi Monero${s.network === 'stagenet' ? ' (stagenet)' : ''}\n\nÀ : ${s.destination.address}\nType : ${kind}\n${line}\n`, `Monero send${s.network === 'stagenet' ? ' (stagenet)' : ''}\n\nTo: ${s.destination.address}\nType: ${kind}\n${line}\n`) +
      l10n(`Montant : ${xmrText(s.amount)} (${s.amount} piconero)\nFrais réseau : ${xmrText(s.fee)}\nMonnaie rendue à ton adresse principale : ${xmrText(s.change)}\n${line}\n`, `Amount: ${xmrText(s.amount)} (${s.amount} piconero)\nNetwork fee: ${xmrText(s.fee)}\nChange returned to your primary address: ${xmrText(s.change)}\n${line}\n`) +
      l10n(`Dépensé : ${xmrText(s.inputsTotal)} (${s.inputCount} de tes sorties, anneaux de ${s.ringSize} membres)\n`, `Spent: ${xmrText(s.inputsTotal)} (${s.inputCount} of your outputs, rings of ${s.ringSize} members)\n`)
    );
  };

  const probe = async (network: string, s: MoneroServer): Promise<ServerTestResult['detected']> => {
    if (network !== 'mainnet' && network !== 'testnet') throw new IpcError('SERVER_INVALID', l10n(`Serveur invalide : monero : réseau inconnu « ${network} » (mainnet ou testnet)`, `Invalid server: monero: unknown network “${network}” (mainnet or testnet)`));
    if (s.kind === 'node') {
      const bad = checkServerUrl(s.url, torOn());
      if (bad) throw new IpcError('SERVER_INVALID', l10n(`Serveur invalide : monero ${network} : ${bad}`, `Invalid server: monero ${network}: ${bad}`));
    }
    if (torOn()) await d.tor.waitReady();
    await wait(100 + Math.random() * 200);
    if (s.kind === 'node' && has(s.url, 'down')) throw unreachable(l10n(`${hostOf(s.url)} : délai de connexion dépassé`, `${hostOf(s.url)}: connection timed out`));
    if (s.kind === 'node' && has(s.url, 'wrong')) {
      throw new IpcError('SERVER_WRONG_NETWORK', l10n(`Mauvais réseau : ce nœud Monero est sur « ${network === 'mainnet' ? 'stagenet' : 'mainnet'} », pas sur ${network === 'mainnet' ? 'mainnet' : 'stagenet'}`, `Wrong network: this Monero node is on “${network === 'mainnet' ? 'stagenet' : 'mainnet'}”, not on ${network === 'mainnet' ? 'mainnet' : 'stagenet'}`));
    }
    return { network: network === 'mainnet' ? 'mainnet' : 'stagenet', blockHeight: state.tip };
  };

  const handlers: Record<Extract<keyof Commands, `xmr_${string}`>, (a: Record<string, unknown>) => unknown> = {
    xmr_backend_info: (): XmrBackendInfo => {
      const s = serverOf();
      return { kind: s.kind, network: d.network === 'mainnet' ? 'mainnet' : 'stagenet', label: s.kind === 'node' ? hostOf(s.url) : defaultHost, tor: torOn() };
    },
    xmr_address: (a) => {
      d.requireUnlocked();
      const index = Number(a.index ?? 0);
      if (!Number.isInteger(index) || index < 0 || index > state.subaddresses) throw invalidInput(l10n('sous-adresse Monero pas encore créée (xmr_new_subaddress)', 'Monero subaddress not created yet (xmr_new_subaddress)'));
      return demoXmrAddress(d.network, accountOf(a), index);
    },
    xmr_new_subaddress: (a) => {
      d.requireUnlocked();
      state.subaddresses += 1;
      return { index: state.subaddresses, address: demoXmrAddress(d.network, accountOf(a), state.subaddresses), received: '0' };
    },
    xmr_subaddresses: (a) => {
      d.requireUnlocked();
      return subaddressList(accountOf(a));
    },
    xmr_status: async (a) => {
      d.requireUnlocked();
      accountOf(a);
      await backend();
      step();
      return status();
    },
    xmr_sync: async (a) => {
      d.requireUnlocked();
      accountOf(a);
      await backend();
      state.running = true;
      return status();
    },
    xmr_txs: async (a) => {
      d.requireUnlocked();
      if (accountOf(a) !== 0) return [];
      await backend();
      return [...state.history]
        .map((h) => ({ ...h, confirmations: h.height === 0 ? 0 : Math.max(0, state.tip - h.height) }))
        .sort((x, y) => (y.height === 0 ? Infinity : y.height) - (x.height === 0 ? Infinity : x.height));
    },
    xmr_validate_address: (a) => checkXmrAddress(a.address, d.network),
    xmr_set_restore_height: async (a) => {
      d.requireUnlocked();
      if (state.running) throw invalidInput(l10n('Monero : un scan est en cours, réessaie quand il est terminé', 'Monero: a scan is in progress, try again when it is finished'));
      const h = Number(a.height);
      if (!Number.isInteger(h) || h < 0) throw invalidInput(l10n('hauteur invalide', 'invalid height'));
      await backend();
      state.restoreHeight = Math.min(h, state.tip);
      state.scanned = state.restoreHeight;
      state.outputs = [];
      state.history = state.history.filter((x) => x.height === 0);
      return status();
    },
    xmr_prepare_tx: async (a) => {
      d.requireUnlocked();
      const account = accountOf(a);
      const destination = checkXmrAddress(a.to, d.network);
      let amount: bigint | null = null;
      if (a.amount !== undefined && a.amount !== null) {
        const s = String(a.amount).trim();
        if (!/^\d+$/.test(s) || BigInt(s) <= 0n) throw invalidInput(l10n('montant en piconero invalide', 'invalid piconero amount'));
        amount = BigInt(s);
      }
      await backend();
      if (state.restoreHeight === null || state.scanned + 2 < state.tip) {
        throw invalidInput(l10n(`Monero : synchronisation incomplète (bloc ${state.scanned} sur ${state.tip}) : attends la fin du scan`, `Monero: sync incomplete (block ${state.scanned} of ${state.tip}): wait for the scan to finish`));
      }
      const { total, unlocked } = balances();
      if (unlocked === 0n) throw invalidInput(total > 0n ? l10n('Monero : fonds encore bloqués (10 confirmations, ≈ 20 min, avant de pouvoir les dépenser)', 'Monero: funds still locked (10 confirmations, ≈ 20 min, before they can be spent)') : l10n('Monero : aucun fonds disponible', 'Monero: no funds available'));
      const inputs = state.outputs.filter((o) => !o.spent && state.tip >= o.height + CONFIRMATIONS).sort((x, y) => (y.amount > x.amount ? 1 : -1));
      const chosen: DemoOutput[] = [];
      let sum = 0n;
      for (const o of inputs) {
        if (amount !== null && sum >= amount + FEE) break;
        chosen.push(o);
        sum += o.amount;
      }
      const send = amount ?? sum - FEE;
      if (send <= 0n) throw invalidInput(l10n('Monero : solde inférieur aux frais', 'Monero: balance lower than the fee'));
      if (sum < send + FEE) throw invalidInput(l10n(`fonds insuffisants : ${sum} piconero disponibles, ${send} demandés + ${FEE} de frais`, `insufficient funds: ${sum} piconero available, ${send} requested + ${FEE} fee`));
      const own = subaddressList(account).map((s) => s.address);
      const warnings: XmrWarning[] = [];
      if (destination.kind === 'integrated') warnings.push('integratedAddress');
      if (FEE > send) warnings.push('feeAboveAmount');
      if (own.includes(destination.address)) warnings.push('ownAddress');
      const summary: XmrTxSummary = {
        network: d.network === 'mainnet' ? 'mainnet' : 'stagenet',
        account,
        destination,
        amount: send.toString(),
        fee: FEE.toString(),
        change: (sum - send - FEE).toString(),
        inputsTotal: sum.toString(),
        inputCount: chosen.length,
        ringSize: 16,
        feePerWeight: '80000',
        warnings,
        requiresExtraConfirmation: warnings.length > 0,
      };
      const id = bytesToHex(keyOf(`xmr-pending-${d.now()}-${Math.random()}`)).slice(0, 32);
      state.pending.set(id, { summary, created: d.now() });
      return { id, summary };
    },
    xmr_send_tx: async (a) => {
      d.requireUnlocked();
      const id = String(a.id ?? '').trim();
      const p = state.pending.get(id);
      state.pending.delete(id);
      if (!p) throw invalidInput(l10n('transfert Monero inconnu ou expiré : prépare-le à nouveau', 'unknown or expired Monero transfer: prepare it again'));
      if (d.now() - p.created >= 600_000) throw invalidInput(l10n('transfert Monero préparé il y a plus de 10 min : prépare-le à nouveau', 'Monero transfer prepared more than 10 min ago: prepare it again'));
      if (p.summary.account !== accountOf(a)) throw invalidInput(l10n('transfert préparé pour un autre compte ou réseau', 'transfer prepared for another account or network'));
      d.checkPassword(a.password);
      if (!d.confirm(l10n(`Confirmer l'envoi Monero\n${describe(p.summary)}`, `Confirm the Monero send\n${describe(p.summary)}`))) throw new IpcError('USER_REJECTED', l10n('Action annulée.', 'Action cancelled.'));
      if (p.summary.requiresExtraConfirmation && !d.confirm(l10n('Attention : envoi Monero à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?', 'Warning: Monero send to check\nOnly sign if you know exactly why. Sign anyway?'))) throw new IpcError('USER_REJECTED', l10n('Action annulée.', 'Action cancelled.'));
      await backend();
      // Spend the largest unlocked outputs, give the change back as a new (locked) output.
      let need = BigInt(p.summary.inputsTotal);
      for (const o of state.outputs.filter((x) => !x.spent && state.tip >= x.height + CONFIRMATIONS).sort((x, y) => (y.amount > x.amount ? 1 : -1))) {
        if (need <= 0n) break;
        o.spent = true;
        need -= o.amount;
      }
      const change = BigInt(p.summary.change);
      if (change > 0n) state.outputs.push({ amount: change, height: state.tip + 1, subaddress: 0, spent: false });
      const txid = bytesToHex(keyOf(`xmr-sent-${id}`));
      state.history.push({ txid, direction: 'out', amount: p.summary.amount, fee: p.summary.fee, to: p.summary.destination.address, height: 0, time: Math.floor(d.now() / 1000), confirmations: 0 });
      return { txid, summary: p.summary };
    },
    xmr_seed_show: (a) => {
      d.requireUnlocked();
      accountOf(a);
      d.checkPassword(a.password);
      // Demo: never shows words (the real app opens a native window, the UI gets nothing).
      d.confirm(l10n('Phrase Monero (25 mots)\nMode démo : la phrase n’est pas affichée. Dans l’application, elle apparaît dans une fenêtre du système, jamais dans l’interface.', 'Monero phrase (25 words)\nDemo mode: the phrase is not shown. In the app, it appears in a system window, never in the interface.'));
      return null;
    },
  };

  return {
    state,
    handlers,
    probe,
    validate: (servers: Settings['servers'], tor: boolean) => {
      for (const nk of ['mainnet', 'testnet'] as const) {
        const s = servers.monero?.[nk];
        if (s?.kind === 'node') {
          const bad = checkServerUrl(s.url, tor);
          if (bad) throw new IpcError('SERVER_INVALID', l10n(`Serveur invalide : monero ${nk} : ${bad}`, `Invalid server: monero ${nk}: ${bad}`));
        }
      }
    },
  };
}
