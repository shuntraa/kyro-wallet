// SPDX-License-Identifier: GPL-3.0-or-later
// DEMO ONLY — Sui (`sui_*`, docs/IPC.md §2.11), mirroring apps/desktop/src-tauri/src/

import { blake2b } from '@noble/hashes/blake2b';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { base58, base64 } from '@scure/base';
import {
  IpcError,
  type Commands,
  type Network,
  type Settings,
  type SuiBackendInfo,
  type SuiBalance,
  type SuiContext,
  type SuiHistoryEntry,
  type SuiTxSummary,
  type SuiWarning,
} from './ipc';
import { decimalMark, l10n } from './i18n';
import type { DemoTor } from './mock-tor';

const MIST = 1_000_000_000n;
const REFERENCE_GAS_PRICE = 1000n;
/** Simulated costs of a SUI transfer (MIST), close to what testnet reports. */
const COMPUTATION = 1_000_000n;
const STORAGE = 1_976_000n;
const REBATE = 978_120n;
const HIGH_GAS_BUDGET = 100_000_000n;
/** Demo: an executed transfer is indexed after this long. */
const INDEX_MS = 3_000;

const enc = (s: string) => new TextEncoder().encode(s);

/** `0x` + 64 hex of BLAKE2b-256(0x00 || 32 bytes): the shape of a real ed25519 Sui address. */
export function suiAddressOf(bytes32: Uint8Array): string {
  return `0x${bytesToHex(blake2b(new Uint8Array([0, ...bytes32]), { dkLen: 32 }))}`;
}

/** Demo address of Sui account `account` (a fixed demo value per account, not derived from the seed). */
export function demoSuiAddress(account: number): string {
  return suiAddressOf(sha256(enc(`kyro-demo-sui-account-${account}`)));
}

const invalidInput = (m: string) => new IpcError('INVALID_INPUT', l10n(`Entrée invalide : ${m}`, `Invalid input: ${m}`));

/** wallet-core `sui_parse_address`, same messages. */
export function checkSuiAddress(a: unknown): string {
  const s = String(a ?? '').trim();
  if (s.endsWith('.sui') || s.startsWith('@')) throw invalidInput(l10n("les noms SuiNS ne sont pas pris en charge : colle l'adresse 0x… complète", 'SuiNS names are not supported: paste the full 0x… address'));
  if (!s.startsWith('0x')) throw invalidInput(l10n('adresse Sui invalide : 0x suivi de 64 caractères hexadécimaux attendu', 'invalid Sui address: 0x followed by 64 hexadecimal characters expected'));
  const h = s.slice(2);
  if (h.length !== 64) throw invalidInput(l10n('adresse Sui invalide : 64 caractères hexadécimaux attendus après 0x (forme courte refusée)', 'invalid Sui address: 64 hexadecimal characters expected after 0x (short form refused)'));
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw invalidInput(l10n('adresse Sui invalide (caractère non hexadécimal)', 'invalid Sui address (non-hexadecimal character)'));
  return `0x${h.toLowerCase()}`;
}

/** `format_units_in(lang, mist, 9)` + « SUI », decimal mark of the language. */
export function suiText(mist: bigint | string): string {
  const v = BigInt(mist);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % MIST).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '−' : ''}${a / MIST}${frac ? `${decimalMark()}${frac}` : ''} SUI`;
}

interface DemoCoin {
  id: string;
  version: number;
  balance: bigint;
}

interface DemoSuiTx {
  sender: string;
  recipient: string;
  /** MIST; null = everything. */
  amount: string | null;
  gasCoins: Array<{ objectId: string; version: string; digest: string }>;
  gasPrice: string;
  gasBudget: string;
  expirationEpoch: number;
}

export interface DemoSuiDeps {
  network: Network;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
  now: () => number;
}

export interface DemoSuiState {
  me: string;
  friend: string;
  coins: Map<string, DemoCoin[]>;
  addressBalance: Map<string, bigint>;
  history: Array<SuiHistoryEntry & { owner: string }>;
  executed: Map<string, { at: number }>;
  epoch: number;
}

export function createDemoSui(d: DemoSuiDeps) {
  const netKey = d.network === 'mainnet' ? 'mainnet' : 'testnet';
  const me = demoSuiAddress(0);
  const friend = suiAddressOf(sha256(enc('kyro-demo-sui-friend')));
  const t0 = d.now();
  let nextObj = 1;
  const coin = (balance: bigint): DemoCoin => ({ id: suiAddressOf(sha256(enc(`kyro-demo-sui-coin-${nextObj++}`))), version: 700_000 + nextObj, balance });
  const iso = (ms: number) => new Date(ms).toISOString();
  const state: DemoSuiState = {
    me,
    friend,
    coins: new Map([
      [me, [coin(12n * MIST + 500_000_000n), coin(3n * MIST)]],
      [friend, [coin(400n * MIST)]],
    ]),
    addressBalance: new Map([[me, 0n]]),
    history: [
      { owner: me, digest: base58.encode(sha256(enc('sui-in-2'))), timestamp: iso(t0 - 86_400_000), checkpoint: 240_118_002, success: true, sender: friend, change: (3n * MIST).toString(), fee: null, counterparty: friend, otherCoins: false },
      { owner: me, digest: base58.encode(sha256(enc('sui-in-1'))), timestamp: iso(t0 - 4 * 86_400_000), checkpoint: 239_870_411, success: true, sender: friend, change: (12n * MIST + 500_000_000n).toString(), fee: null, counterparty: friend, otherCoins: false },
    ],
    executed: new Map(),
    epoch: d.network === 'mainnet' ? 1298 : 1270,
  };

  const torOn = () => d.settings().tor.enabled;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const backend = async () => {
    if (torOn()) await d.tor.waitReady();
    await wait(50 + Math.random() * 120);
  };
  const coinsOf = (a: string) => [...(state.coins.get(a) ?? [])].sort((x, y) => (y.balance > x.balance ? 1 : y.balance < x.balance ? -1 : 0));
  const sum = (cs: DemoCoin[]) => cs.reduce((s, c) => s + c.balance, 0n);
  const digestOfCoin = (c: DemoCoin) => base58.encode(sha256(enc(`${c.id}:${c.version}`)));

  const encode = (t: DemoSuiTx) => base64.encode(enc(JSON.stringify(t)));
  const digestOf = (bcs: string) => base58.encode(sha256(enc(`TransactionData::${bcs}`)));
  const decode = (bcs: unknown, sender: string): { t: DemoSuiTx; summary: SuiTxSummary } => {
    let t: DemoSuiTx;
    try {
      t = JSON.parse(new TextDecoder().decode(base64.decode(String(bcs ?? '').trim()))) as DemoSuiTx;
    } catch {
      throw invalidInput(l10n('transaction : base64 attendu', 'transaction: base64 expected'));
    }
    if (t.sender !== sender) throw invalidInput(l10n("transaction Sui refusée : l'expéditeur n'est pas l'adresse de ce compte", 'Sui transaction refused: the sender is not this account’s address'));
    checkSuiAddress(t.recipient);
    const warnings: SuiWarning[] = [];
    if (t.amount === null) warnings.push({ kind: 'sendAll' });
    if (t.recipient === t.sender) warnings.push({ kind: 'selfTransfer' });
    if (BigInt(t.gasBudget) > HIGH_GAS_BUDGET) warnings.push({ kind: 'highGasBudget' });
    const s = String(bcs).trim();
    return {
      t,
      summary: {
        sender: t.sender,
        recipient: t.recipient,
        coinType: '0x2::sui::SUI',
        amount: t.amount,
        gasBudget: t.gasBudget,
        gasPrice: t.gasPrice,
        gasCoins: t.gasCoins,
        expirationEpoch: t.expirationEpoch,
        digest: digestOf(s),
        warnings,
        requiresExtraConfirmation: warnings.length > 0,
      },
    };
  };

  const budgetOf = () => COMPUTATION + 1000n * REFERENCE_GAS_PRICE + (STORAGE - REBATE);
  const insufficient = (have: bigint, need: bigint) => invalidInput(l10n(`solde insuffisant : ${suiText(have)} dans les pièces SUI, il en faut ${suiText(need)} (montant + budget de gaz)`, `insufficient balance: ${suiText(have)} in SUI coins, ${suiText(need)} needed (amount + gas budget)`));

  /** commands_sui.rs prepare_sign: live checks, then the simulated context. */
  const prepare = (bcs: unknown, sender: string): { t: DemoSuiTx; summary: SuiTxSummary; context: SuiContext } => {
    const { t, summary } = decode(bcs, sender);
    if (t.expirationEpoch < state.epoch) throw invalidInput(l10n(`transfert Sui expiré (époque ${t.expirationEpoch} terminée, époque actuelle ${state.epoch}) : reconstruis-le`, `Sui transfer expired (epoch ${t.expirationEpoch} over, current epoch ${state.epoch}): rebuild it`));
    const coins = coinsOf(sender);
    let gasTotal = 0n;
    const gasCoinBalances: string[] = [];
    for (const g of t.gasCoins) {
      const c = coins.find((x) => x.id === g.objectId && String(x.version) === g.version && digestOfCoin(x) === g.digest);
      if (!c) throw invalidInput(l10n('les pièces de gaz ont changé depuis la préparation : reconstruis le transfert', 'the gas coins changed since preparation: rebuild the transfer'));
      gasTotal += c.balance;
      gasCoinBalances.push(c.balance.toString());
    }
    const budget = BigInt(t.gasBudget);
    const need = (t.amount === null ? 0n : BigInt(t.amount)) + budget;
    if (need > gasTotal || (t.amount === null && budget >= gasTotal)) throw insufficient(gasTotal, need);
    const fee = COMPUTATION + STORAGE - REBATE;
    return {
      t,
      summary,
      context: {
        balance: sum(coins).toString(),
        gasCoinsTotal: gasTotal.toString(),
        gasCoinBalances,
        referenceGasPrice: REFERENCE_GAS_PRICE.toString(),
        epoch: state.epoch,
        computationCost: COMPUTATION.toString(),
        storageCost: STORAGE.toString(),
        storageRebate: REBATE.toString(),
        fee: fee.toString(),
        receives: t.amount === null && t.recipient !== sender ? (gasTotal - fee).toString() : null,
      },
    };
  };

  const SHOWN_GAS_COINS = 5;
  const describe = (s: SuiTxSummary, c: SuiContext): string => {
    const line = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    let out = l10n(`Envoi Sui${d.network === 'testnet' ? ' (testnet)' : ''}\n\nÀ : ${s.recipient}\n(adresse Sui complète : 0x + 64 caractères, sans somme de contrôle — compare-la en entier)\n${line}\n`, `Sui send${d.network === 'testnet' ? ' (testnet)' : ''}\n\nTo: ${s.recipient}\n(full Sui address: 0x + 64 characters, no checksum — compare all of it)\n${line}\n`);
    if (s.amount !== null) out += l10n(`Montant : ${suiText(s.amount)} (${s.amount} MIST)\n`, `Amount: ${suiText(s.amount)} (${s.amount} MIST)\n`);
    else {
      out += l10n('Montant : TOUT LE SOLDE des pièces de gaz ci-dessous, moins les frais\n', 'Amount: THE WHOLE BALANCE of the gas coins below, minus the fee\n');
      if (c.receives) out += l10n(`(le destinataire recevrait ${suiText(c.receives)} selon la simulation)\n`, `(the recipient would receive ${suiText(c.receives)} according to the simulation)\n`);
    }
    out += l10n(`Jeton : SUI (${s.coinType})\n${line}\n`, `Token: SUI (${s.coinType})\n${line}\n`);
    out += l10n(`Frais estimés (simulation) : ${suiText(c.fee)} — calcul ${suiText(c.computationCost)} + stockage ${suiText(c.storageCost)} − remboursement ${suiText(c.storageRebate)}\n`, `Estimated fee (simulation): ${suiText(c.fee)} — computation ${suiText(c.computationCost)} + storage ${suiText(c.storageCost)} − rebate ${suiText(c.storageRebate)}\n`);
    out += l10n(`Budget de gaz maximal : ${suiText(s.gasBudget)} (${s.gasBudget} MIST) · prix du gaz : ${s.gasPrice} MIST/unité (référence ${c.referenceGasPrice})\n`, `Maximum gas budget: ${suiText(s.gasBudget)} (${s.gasBudget} MIST) · gas price: ${s.gasPrice} MIST/unit (reference ${c.referenceGasPrice})\n`);
    out += l10n(`Pièces de gaz : ${s.gasCoins.length} (total ${suiText(c.gasCoinsTotal)}) · solde dépensable : ${suiText(c.balance)}\n`, `Gas coins: ${s.gasCoins.length} (total ${suiText(c.gasCoinsTotal)}) · spendable balance: ${suiText(c.balance)}\n`);
    s.gasCoins.slice(0, SHOWN_GAS_COINS).forEach((g, i) => (out += `  • ${g.objectId} (version ${g.version})${l10n(' : ', ': ')}${c.gasCoinBalances[i] !== undefined ? suiText(c.gasCoinBalances[i]) : '?'}\n`));
    if (s.gasCoins.length > SHOWN_GAS_COINS) {
      const rest = c.gasCoinBalances.slice(SHOWN_GAS_COINS).reduce((a, b) => a + BigInt(b), 0n);
      out += l10n(`  • … et ${s.gasCoins.length - SHOWN_GAS_COINS} autres pièces (${suiText(rest)})\n`, `  • … and ${s.gasCoins.length - SHOWN_GAS_COINS} more coins (${suiText(rest)})\n`);
    }
    out += l10n(`Valable jusqu'à la fin de l'époque n° ${s.expirationEpoch} (époque actuelle ${c.epoch})\nEmpreinte : ${s.digest}\n`, `Valid until the end of epoch #${s.expirationEpoch} (current epoch ${c.epoch})\nDigest: ${s.digest}\n`);
    return out;
  };

  const accountArg = (a: unknown) => {
    const n = a === undefined ? 0 : Number(a);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw invalidInput(l10n('numéro de compte : au plus 100', 'account number: at most 100'));
    return n;
  };

  const handlers: Record<Extract<keyof Commands, `sui_${string}`>, (a: Record<string, unknown>) => unknown> = {
    sui_backend_info: (): SuiBackendInfo => ({ kind: 'default', network: netKey, label: d.network === 'mainnet' ? 'graphql.mainnet.sui.io' : 'graphql.testnet.sui.io', tor: torOn() }),
    sui_address: (a) => {
      d.requireUnlocked();
      return demoSuiAddress(accountArg(a.account));
    },
    sui_balance: async (a): Promise<SuiBalance> => {
      const addr = checkSuiAddress(a.address);
      await backend();
      const coin = sum(state.coins.get(addr) ?? []);
      const ab = state.addressBalance.get(addr) ?? 0n;
      return { address: addr, total: (coin + ab).toString(), coin: coin.toString(), addressBalance: ab.toString() };
    },
    sui_txs: async (a) => {
      const addr = checkSuiAddress(a.address);
      await backend();
      return state.history.filter((t) => t.owner === addr).slice(0, 20).map(({ owner: _o, ...t }) => t);
    },
    sui_build_tx: async (a) => {
      d.requireUnlocked();
      const sender = demoSuiAddress(accountArg(a.account));
      const to = checkSuiAddress(a.to);
      const all = a.all === true;
      let amount: bigint | null = null;
      if (!all) {
        const s = String(a.amount ?? '').trim();
        if (!/^\d+$/.test(s) || BigInt(s) <= 0n) throw invalidInput(l10n('montant en MIST invalide', 'invalid MIST amount'));
        amount = BigInt(s);
      }
      await backend();
      const coins = coinsOf(sender);
      if (coins.length === 0) throw invalidInput(l10n('aucun SUI sur ce compte', 'no SUI on this account'));
      const budget = budgetOf();
      const picked: DemoCoin[] = [];
      for (const c of coins) {
        picked.push(c);
        if (amount !== null && sum(picked) >= amount + 50_000_000n) break;
      }
      const total = sum(picked);
      const need = (amount ?? 0n) + budget;
      if (need > total || (amount === null && budget >= total)) throw insufficient(total, need);
      const t: DemoSuiTx = {
        sender,
        recipient: to,
        amount: amount === null ? null : amount.toString(),
        gasCoins: picked.map((c) => ({ objectId: c.id, version: String(c.version), digest: digestOfCoin(c) })),
        gasPrice: REFERENCE_GAS_PRICE.toString(),
        gasBudget: budget.toString(),
        expirationEpoch: state.epoch + 1,
      };
      const bcs = encode(t);
      const { summary, context } = prepare(bcs, sender);
      return { bcs, summary, context };
    },
    sui_token_balances: () => Promise.resolve([]),
    sui_build_token_tx: () => Promise.reject(new Error(l10n('Démo : envoi de jetons Sui non simulé', 'Demo: Sui token sends are not simulated'))),
    sui_sign_tx: async (a) => {
      d.requireUnlocked();
      const sender = demoSuiAddress(accountArg(a.account));
      await backend();
      const { summary, context } = prepare(a.bcs, sender);
      d.checkPassword(a.password);
      if (!d.confirm(l10n(`Confirmer le transfert Sui\n${describe(summary, context)}`, `Confirm the Sui transfer\n${describe(summary, context)}`))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      if (summary.requiresExtraConfirmation && !d.confirm(l10n('Attention : transfert à vérifier\nNe signe que si tu sais exactement pourquoi. Signer quand même ?', 'Warning: transfer to check\nOnly sign if you know exactly why. Sign anyway?'))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      const signature = base64.encode(new Uint8Array([0, ...sha256(enc(`sig:${String(a.bcs)}`)), ...sha256(enc('sig2')), ...sha256(enc(sender))]));
      return { bcs: String(a.bcs).trim(), signature, digest: summary.digest, summary, context };
    },
    sui_broadcast: async (a) => {
      const sender = demoSuiAddress(accountArg(a.account));
      const sig = base64.decode(String(a.signature ?? ''));
      if (sig.length !== 97 || sig[0] !== 0) throw invalidInput(l10n('transaction Sui refusée : signature : ed25519 (0x00 || 64 octets || 32 octets) attendue', 'Sui transaction refused: signature: ed25519 (0x00 || 64 bytes || 32 bytes) expected'));
      await backend();
      const { t, summary, context } = prepare(a.bcs, sender);
      const fee = BigInt(context.fee);
      const coins = state.coins.get(sender) ?? [];
      const gasIds = new Set(t.gasCoins.map((g) => g.objectId));
      const gas = coins.filter((c) => gasIds.has(c.id));
      const rest = coins.filter((c) => !gasIds.has(c.id));
      const total = sum(gas);
      const sent = t.amount === null ? total - fee : BigInt(t.amount);
      const left = total - sent - fee;
      const [first] = gas;
      // The gas coins merge into the first one (new version); « tout le solde » leaves nothing.
      state.coins.set(sender, [...rest, ...(t.amount !== null && first ? [{ id: first.id, version: first.version + 1, balance: left }] : [])]);
      if (t.recipient !== sender) {
        state.coins.set(t.recipient, [...(state.coins.get(t.recipient) ?? []), coin(sent)]);
      }
      state.executed.set(summary.digest, { at: d.now() });
      state.epoch = Math.max(state.epoch, d.network === 'mainnet' ? 1298 : 1270);
      const entry = { digest: summary.digest, timestamp: iso(d.now()), checkpoint: 240_200_000 + state.history.length, success: true, sender };
      state.history.unshift({ ...entry, owner: sender, change: (-(sent + fee)).toString(), fee: fee.toString(), counterparty: t.recipient, otherCoins: false });
      if (t.recipient !== sender) state.history.unshift({ ...entry, owner: t.recipient, change: sent.toString(), fee: null, counterparty: sender, otherCoins: false });
      return summary.digest;
    },
    sui_tx_status: async (a) => {
      const dg = String(a.digest ?? '').trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dg)) throw invalidInput(l10n('empreinte Sui : base58 de 32 octets attendue', 'Sui digest: base58 of 32 bytes expected'));
      await backend();
      const s = state.executed.get(dg);
      if (!s || d.now() - s.at < INDEX_MS) return { found: false, success: false, error: null, checkpoint: null };
      return { found: true, success: true, error: null, checkpoint: 240_200_000 };
    },
  };

  return { state, handlers };
}
