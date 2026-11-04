// SPDX-License-Identifier: GPL-3.0-or-later
// DEMO ONLY — Kaspa (`kas_*`, docs/IPC.md §2.11), mirroring apps/desktop/src-tauri/src/

import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  IpcError,
  type Commands,
  type KaspaAccountInfo,
  type KaspaBackendInfo,
  type KaspaHistoryEntry,
  type KaspaMass,
  type KaspaTxSummary,
  type Network,
  type Settings,
} from './ipc';
import { kaspaAddressDecode, kaspaAddressEncode, kaspaAddressProblem, type KaspaAddressKind } from './kaspa';
import { decimalMark, l10n, sentence } from './i18n';
import type { DemoTor } from './mock-tor';

const C = 1_000_000_000_000n;
const MIN_SEND = 20_000_000n;
const MAX_FOLDED = 20_000_000n;
const MAX_MASS = 100_000n;
const MAX_INPUTS = 84;
const WINDOW = 20;
const ACCEPT_MS = 2_000;

/** x-only key → `kaspa:` / `kaspatest:` P2PK address at `m/44'/111111'/account'/change/index`. */
export function demoKaspaAddress(seed: Uint8Array, network: Network, account: number, change = false, index = 0): string {
  const pk = HDKey.fromMasterSeed(seed).derive(`m/44'/111111'/${account}'/${change ? 1 : 0}/${index}`).publicKey;
  if (!pk) throw new IpcError('INTERNAL', l10n('dérivation Kaspa', 'Kaspa derivation'));
  return kaspaAddressEncode(network, 'pubKey', pk.slice(1));
}

const invalidInput = (m: string) => new IpcError('INVALID_INPUT', sentence(m));
const kas = (sompi: bigint | string) => {
  const v = BigInt(sompi);
  const frac = (v % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${v / 100_000_000n}${frac ? `${decimalMark()}${frac}` : ''} KAS`;
};

function scriptOf(network: Network, address: string): string {
  const d = kaspaAddressDecode(network, address);
  if (!d) throw invalidInput(kaspaAddressProblem(address, network) ?? l10n('adresse Kaspa invalide', 'invalid Kaspa address'));
  const p = bytesToHex(d.payload);
  const forms: Record<KaspaAddressKind, string> = { pubKey: `20${p}ac`, pubKeyEcdsa: `21${p}ab`, scriptHash: `aa20${p}87` };
  return forms[d.kind];
}

function addressOfScript(network: Network, script: string): string | null {
  const m = /^20([0-9a-f]{64})ac$/.exec(script) ?? null;
  if (m?.[1]) return kaspaAddressEncode(network, 'pubKey', hexToBytes(m[1]));
  const e = /^21([0-9a-f]{66})ab$/.exec(script);
  if (e?.[1]) return kaspaAddressEncode(network, 'pubKeyEcdsa', hexToBytes(e[1]));
  const h = /^aa20([0-9a-f]{64})87$/.exec(script);
  if (h?.[1]) return kaspaAddressEncode(network, 'scriptHash', hexToBytes(h[1]));
  return null;
}

interface DemoCoin {
  txid: string;
  index: number;
  amount: bigint;
  address: string;
}

interface DemoTx {
  version: 0;
  inputs: Array<{ previousOutpoint: { transactionId: string; index: number }; signatureScript: string; sequence: 0; sigOpCount: 1 }>;
  outputs: Array<{ amount: number; scriptPublicKey: { version: 0; scriptPublicKey: string } }>;
  lockTime: 0;
  subnetworkId: string;
  gas: 0;
  payload: '';
}

export interface DemoKaspaDeps {
  network: Network;
  seed: Uint8Array;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
  now: () => number;
}

export interface DemoKaspaState {
  me: string;
  change: string;
  friend: string;
  coins: DemoCoin[];
  history: KaspaHistoryEntry[];
  submitted: Map<string, number>;
}

/** Masses (grams) as wallet-core for `n` P2PK inputs and these outputs. */
export function demoKaspaMass(inputs: bigint[], outputs: Array<{ amount: bigint; scriptLen: number }>): KaspaMass | null {
  if (inputs.length === 0 || [...inputs, ...outputs.map((o) => o.amount)].some((a) => a <= 0n)) return null;
  const size = 94 + 118 * inputs.length + outputs.reduce((s, o) => s + 18 + o.scriptLen, 0);
  const compute = size + outputs.reduce((s, o) => s + 10 * (2 + o.scriptLen), 0) + 1000 * inputs.length;
  const transient = 4 * size;
  const harmonicOuts = outputs.reduce((s, o) => s + C / o.amount, 0n);
  const relaxed = outputs.length === 1 || (inputs.length <= 2 && (inputs.length === 1 || outputs.length === 2));
  let storage: bigint;
  if (relaxed) {
    const harmonicIns = inputs.reduce((s, a) => s + C / a, 0n);
    storage = harmonicOuts > harmonicIns ? harmonicOuts - harmonicIns : 0n;
  } else {
    const mean = inputs.reduce((s, a) => s + a, 0n) / BigInt(inputs.length);
    const arithmetic = BigInt(inputs.length) * (C / (mean > 0n ? mean : 1n));
    storage = harmonicOuts > arithmetic ? harmonicOuts - arithmetic : 0n;
  }
  const relay = Math.max(compute, Math.ceil(transient / 2));
  const s = Number(storage > 10n ** 12n ? 10n ** 12n : storage);
  return { compute, transient, storage: s, relay, total: Math.max(relay, s) };
}

export function createDemoKaspa(d: DemoKaspaDeps) {
  const netKey = d.network === 'mainnet' ? 'mainnet' : 'testnet';
  const defaultHost = d.network === 'mainnet' ? 'api.kaspa.org' : 'api-tn10.kaspa.org';
  const own = (account: number) => [
    ...Array.from({ length: WINDOW }, (_, i) => demoKaspaAddress(d.seed, d.network, account, false, i)),
    ...Array.from({ length: WINDOW }, (_, i) => demoKaspaAddress(d.seed, d.network, account, true, i)),
  ];
  const ours = own(0);
  const me = ours[0]!;
  const change = ours[WINDOW]!;
  const friend = kaspaAddressEncode(d.network, 'pubKey', sha256(new TextEncoder().encode('kyro-demo-kaspa-friend')));
  const exchange = kaspaAddressEncode(d.network, 'pubKey', sha256(new TextEncoder().encode('kyro-demo-kaspa-exchange')));
  const hash = (s: string) => bytesToHex(sha256(new TextEncoder().encode(s)));
  const t0 = d.now();
  const state: DemoKaspaState = {
    me,
    change,
    friend,
    coins: [
      { txid: hash('kas-in-1'), index: 0, amount: 12_550_000_000n, address: me },
      { txid: hash('kas-in-2'), index: 1, amount: 3_000_000_000n, address: me },
      // Change of an earlier send (`…/1/0`): counted because Kyro reads both chains.
      { txid: hash('kas-out-0'), index: 1, amount: 420_000_000n, address: change },
    ],
    history: [
      { txid: hash('kas-out-0'), time: t0 - 2 * 3_600_000, delta: '-1000203600', fee: '203600', counterparty: friend, accepted: true },
      { txid: hash('kas-in-2'), time: t0 - 86_400_000, delta: '3000000000', fee: null, counterparty: exchange, accepted: true },
      { txid: hash('kas-in-1'), time: t0 - 4 * 86_400_000, delta: '12550000000', fee: null, counterparty: exchange, accepted: true },
    ],
    submitted: new Map(),
  };
  const torOn = () => d.settings().tor.enabled;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const backend = async () => {
    if (torOn()) await d.tor.waitReady();
    await wait(40 + Math.random() * 100);
  };
  const account0 = (a: Record<string, unknown>) => {
    const n = a.account === undefined || a.account === null ? 0 : Number(a.account);
    if (n !== 0) throw invalidInput(l10n('mode démo : seul le premier compte Kaspa est simulé', 'demo mode: only the first Kaspa account is simulated'));
  };
  const scriptLen = (s: string) => s.length / 2;

  const summarize = (tx: DemoTx): KaspaTxSummary => {
    const entries = tx.inputs.map((i) => {
      const c = state.coins.find((x) => x.txid === i.previousOutpoint.transactionId && x.index === i.previousOutpoint.index);
      if (!c) throw invalidInput(l10n('pièce déjà dépensée ou inconnue de ce compte, reconstruis la transaction', 'coin already spent or unknown to this account, rebuild the transaction'));
      return c;
    });
    const ownScripts = new Set(ours.map((a) => scriptOf(d.network, a)));
    const inputTotal = entries.reduce((s, c) => s + c.amount, 0n);
    const outputs = tx.outputs.map((o) => {
      const address = addressOfScript(d.network, o.scriptPublicKey.scriptPublicKey);
      return { address, script: o.scriptPublicKey.scriptPublicKey, amount: String(o.amount), isChange: ownScripts.has(o.scriptPublicKey.scriptPublicKey), kind: address ? ('address' as const) : ('unknown' as const) };
    });
    const outTotal = tx.outputs.reduce((s, o) => s + BigInt(o.amount), 0n);
    if (outTotal > inputTotal) throw invalidInput('Kaspa: outputs exceed inputs');
    const mass = demoKaspaMass(entries.map((c) => c.amount), tx.outputs.map((o) => ({ amount: BigInt(o.amount), scriptLen: scriptLen(o.scriptPublicKey.scriptPublicKey) })));
    if (!mass || mass.total > Number(MAX_MASS)) throw invalidInput('Kaspa: mass above the standard limit');
    const fee = inputTotal - outTotal;
    const minimumFee = BigInt(mass.relay) * 100n;
    if (fee < minimumFee) throw invalidInput('Kaspa: fee below the minimum relay fee');
    const warnings: KaspaTxSummary['warnings'] = outputs.flatMap((o, index) => (o.kind === 'unknown' ? [{ kind: 'unknownOutput' as const, index }] : []));
    if (fee > minimumFee * 10n || fee > 100_000_000n) warnings.push({ kind: 'highFee' });
    const unsigned = { ...tx, inputs: tx.inputs.map((i) => ({ ...i, signatureScript: '' })) };
    return {
      txId: hash(JSON.stringify(unsigned)),
      outputs,
      inputs: entries.length,
      inputTotal: String(inputTotal),
      sent: String(outputs.filter((o) => !o.isChange).reduce((s, o) => s + BigInt(o.amount), 0n)),
      fee: String(fee),
      mass,
      minimumFee: String(minimumFee),
      feeRate: Number(fee / BigInt(Math.max(1, mass.relay))),
      hasChange: outputs.some((o) => o.isChange),
      warnings,
      requiresExtraConfirmation: warnings.length > 0,
    };
  };

  const decode = (raw: unknown): DemoTx => {
    try {
      const tx = JSON.parse(String(raw ?? '')) as DemoTx;
      if (tx.version !== 0 || !Array.isArray(tx.inputs) || !Array.isArray(tx.outputs)) throw new Error('shape');
      return tx;
    } catch {
      throw invalidInput('Kaspa: invalid transaction JSON');
    }
  };

  const build = (to: string, amount: bigint | null): DemoTx => {
    const toScript = scriptOf(d.network, to);
    const changeScript = scriptOf(d.network, change);
    const coins = [...state.coins].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
    const make = (chosen: DemoCoin[], outs: Array<{ amount: bigint; script: string }>): DemoTx => ({
      version: 0,
      inputs: chosen.map((c) => ({ previousOutpoint: { transactionId: c.txid, index: c.index }, signatureScript: '', sequence: 0, sigOpCount: 1 })),
      outputs: outs.map((o) => ({ amount: Number(o.amount), scriptPublicKey: { version: 0, scriptPublicKey: o.script } })),
      lockTime: 0,
      subnetworkId: '0'.repeat(40),
      gas: 0,
      payload: '',
    });
    const feeOf = (chosen: DemoCoin[], outs: Array<{ amount: bigint; script: string }>) => {
      const m = demoKaspaMass(chosen.map((c) => c.amount), outs.map((o) => ({ amount: o.amount, scriptLen: scriptLen(o.script) })));
      return m && m.total <= Number(MAX_MASS) ? BigInt(m.relay) * 100n : null;
    };
    if (amount === null) {
      const chosen = coins.slice(0, MAX_INPUTS);
      const total = chosen.reduce((s, c) => s + c.amount, 0n);
      const fee = feeOf(chosen, [{ amount: total, script: toScript }]);
      if (fee === null || total <= fee) throw invalidInput('balance too small to pay the fee');
      return make(chosen, [{ amount: total - fee, script: toScript }]);
    }
    if (amount < MIN_SEND) throw invalidInput("amount too small: at least 0.2 KAS (Kaspa's storage mass, KIP-9, makes tiny outputs non-standard)");
    let total = 0n;
    for (let n = 1; n <= Math.min(coins.length, MAX_INPUTS); n++) {
      const chosen = coins.slice(0, n);
      total += chosen[n - 1]!.amount;
      if (total <= amount) continue;
      let fee = 0n;
      for (let i = 0; i < 16; i++) {
        const c = total - amount - fee;
        if (c <= 0n) break;
        const need = feeOf(chosen, [{ amount, script: toScript }, { amount: c, script: changeScript }]);
        if (need === null) break;
        if (need <= fee) return make(chosen, [{ amount, script: toScript }, { amount: c, script: changeScript }]);
        fee = need;
      }
      const single = feeOf(chosen, [{ amount, script: toScript }]);
      if (single !== null && total - amount >= single && total - amount - single <= MAX_FOLDED) return make(chosen, [{ amount, script: toScript }]);
    }
    throw invalidInput('insufficient funds (amount + fee)');
  };

  const describe = (s: KaspaTxSummary) => {
    let out = l10n(`Envoi Kaspa${d.network === 'testnet' ? ' (testnet-10)' : ''}\n\n`, `Kaspa send${d.network === 'testnet' ? ' (testnet-10)' : ''}\n\n`);
    for (const o of s.outputs) {
      if (o.address && o.isChange) out += l10n(`Monnaie (revient chez toi) : ${kas(o.amount)}\n  ${o.address}\n`, `Change (comes back to you): ${kas(o.amount)}\n  ${o.address}\n`);
      else if (o.address) out += l10n(`À : ${o.address}\nMontant : ${kas(o.amount)}\n`, `To: ${o.address}\nAmount: ${kas(o.amount)}\n`);
      else out += l10n(`Sortie INCONNUE (script non reconnu) : ${kas(o.amount)}\n  script : ${o.script}\n`, `UNKNOWN output (unrecognized script): ${kas(o.amount)}\n  script: ${o.script}\n`);
    }
    out += l10n(`\nFrais : ${kas(s.fee)} (${s.fee} sompi)\nMasse : ${s.mass.total} g (calcul ${s.mass.compute} · stockage KIP-9 ${s.mass.storage} · transitoire ${Math.ceil(s.mass.transient / 2)}) · frais minimum de relais : ${kas(s.minimumFee)}`, `\nFee: ${kas(s.fee)} (${s.fee} sompi)\nMass: ${s.mass.total} g (compute ${s.mass.compute} · KIP-9 storage ${s.mass.storage} · transient ${Math.ceil(s.mass.transient / 2)}) · minimum relay fee: ${kas(s.minimumFee)}`);
    out += l10n(`\nEntrées : ${s.inputs} pièce(s) de ce compte, ${kas(s.inputTotal)} au total`, `\nInputs: ${s.inputs} coin(s) from this account, ${kas(s.inputTotal)} in total`);
    if (!s.hasChange) out += l10n("\n\nPas de monnaie : tout ce qui n'est pas envoyé part en frais (un reste trop petit pour une sortie de monnaie — masse de stockage KIP-9 — y est ajouté).", '\n\nNo change: everything not sent goes to the fee (a remainder too small for a change output — KIP-9 storage mass — is added to it).');
    return `${out}\n\n${l10n('Identifiant : ', 'ID: ')}${s.txId}`;
  };

  const handlers: Record<Extract<keyof Commands, `kas_${string}`>, (a: Record<string, unknown>) => unknown> = {
    kas_backend_info: (): KaspaBackendInfo => ({ kind: 'default', network: netKey, label: defaultHost, tor: torOn() }),
    kas_address: (a) => {
      d.requireUnlocked();
      const n = a.account === undefined || a.account === null ? 0 : Number(a.account);
      return demoKaspaAddress(d.seed, d.network, n);
    },
    kas_account: async (a): Promise<KaspaAccountInfo> => {
      d.requireUnlocked();
      const n = a.account === undefined || a.account === null ? 0 : Number(a.account);
      await backend();
      const coins = n === 0 ? state.coins : [];
      const total = String(coins.reduce((s, c) => s + c.amount, 0n));
      return { address: demoKaspaAddress(d.seed, d.network, n), balance: total, spendable: total, utxoCount: coins.length, scanned: WINDOW };
    },
    kas_txs: async (a) => {
      d.requireUnlocked();
      await backend();
      const n = a.account === undefined || a.account === null ? 0 : Number(a.account);
      return n === 0 ? state.history.map((h) => ({ ...h, accepted: h.accepted || (state.submitted.has(h.txid) && d.now() - state.submitted.get(h.txid)! >= ACCEPT_MS) })) : [];
    },
    kas_watch_account: async (a) => {
      await backend();
      return { address: String(a.address), balance: '0', spendable: '0', utxoCount: 0, scanned: 1 };
    },
    kas_watch_txs: async () => {
      await backend();
      return [];
    },
    kas_tx_status: async (a) => {
      const id = String(a.txid ?? '').trim();
      if (!/^[0-9a-f]{64}$/.test(id)) throw invalidInput(l10n('identifiant : 64 caractères hexadécimaux minuscules', 'ID: 64 lowercase hexadecimal characters'));
      await backend();
      const at = state.submitted.get(id);
      return at === undefined ? { found: false, accepted: false } : { found: true, accepted: d.now() - at >= ACCEPT_MS };
    },
    kas_build_tx: async (a) => {
      d.requireUnlocked();
      account0(a);
      await backend();
      const max = a.max === true;
      const amount = max ? null : /^\d+$/.test(String(a.amount ?? '')) && BigInt(String(a.amount)) > 0n ? BigInt(String(a.amount)) : null;
      if (!max && amount === null) throw invalidInput(l10n('montant en sompi invalide', 'invalid sompi amount'));
      const tx = build(String(a.to ?? '').trim(), amount);
      const spendable = String(state.coins.reduce((s, c) => s + c.amount, 0n));
      return { tx: JSON.stringify(tx), summary: summarize(tx), context: { feerateEstimate: 100, priorityFeerate: 0, spendable } };
    },
    kas_sign_tx: async (a) => {
      d.requireUnlocked();
      account0(a);
      const tx = decode(a.tx);
      if (tx.inputs.some((i) => i.signatureScript !== '')) throw invalidInput(l10n('transaction Kaspa déjà signée', 'Kaspa transaction already signed'));
      await backend();
      const summary = summarize(tx);
      d.checkPassword(a.password);
      if (!d.confirm(l10n(`Confirmer la transaction Kaspa\n${describe(summary)}`, `Confirm the Kaspa transaction\n${describe(summary)}`))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      if (summary.requiresExtraConfirmation && !d.confirm(l10n('Attention : transaction à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?', 'Warning: transaction to check\nOnly sign if you know exactly why. Sign anyway?'))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      const signed: DemoTx = { ...tx, inputs: tx.inputs.map((i, n) => ({ ...i, signatureScript: `41${hash(`sig:${summary.txId}:${n}`)}${hash(`sig2:${n}`)}01` })) };
      return { tx: JSON.stringify(signed), txId: summary.txId, summary };
    },
    kas_broadcast: async (a) => {
      account0(a);
      const tx = decode(a.tx);
      if (tx.inputs.some((i) => !/^41[0-9a-f]{128}01$/.test(i.signatureScript))) throw invalidInput('Kaspa: input not signed');
      await backend();
      const s = summarize(tx);
      state.coins = state.coins.filter((c) => !tx.inputs.some((i) => i.previousOutpoint.transactionId === c.txid && i.previousOutpoint.index === c.index));
      s.outputs.forEach((o, index) => {
        if (o.isChange && o.address) state.coins.push({ txid: s.txId, index, amount: BigInt(o.amount), address: o.address });
      });
      const counterparty = s.outputs.find((o) => !o.isChange)?.address ?? null;
      state.history.unshift({ txid: s.txId, time: d.now(), delta: String(-(BigInt(s.sent) + BigInt(s.fee))), fee: s.fee, counterparty, accepted: false });
      state.submitted.set(s.txId, d.now());
      return s.txId;
    },
  };

  return { state, handlers };
}
