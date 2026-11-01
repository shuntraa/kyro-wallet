// SPDX-License-Identifier: GPL-3.0-or-later
// DEMO ONLY — Polkadot Asset Hub (`dot_*`, docs/IPC.md §2.11), mirroring apps/desktop/src-tauri/

import { blake2b } from '@noble/hashes/blake2b';
import { base58 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { IpcError, type Commands, type DotAccountInfo, type DotBackendInfo, type DotContext, type DotHistoryEntry, type DotTxSummary, type Network, type Settings } from './ipc';
import { decimalMark, l10n } from './i18n';
import type { DemoTor } from './mock-tor';

/** Westend Asset Hub: 12 decimals, ED 0.001 WND; Polkadot Asset Hub: 10 decimals, ED 0.01 DOT. */
export const DOT_CHAINS = {
  mainnet: { chain: 'Polkadot Asset Hub', symbol: 'DOT', decimals: 10, ss58: 0, ed: 100_000_000n, host: 'polkadot-asset-hub-rpc.polkadot.io', spec: 2_005_002, tx: 15 },
  testnet: { chain: 'Westend Asset Hub', symbol: 'WND', decimals: 12, ss58: 42, ed: 1_000_000_000n, host: 'westend-asset-hub-rpc.polkadot.io', spec: 1_025_003, tx: 16 },
} as const;
const ERA_PERIOD = 256;
const ERA_MARGIN = 16;
/** Demo: ~6 s per block; a submitted transfer is finalized after this long. */
const BLOCK_MS = 6_000;
const FINALITY_MS = 5_000;

function checksum(body: Uint8Array): Uint8Array {
  return blake2b(new Uint8Array([...new TextEncoder().encode('SS58PRE'), ...body]), { dkLen: 64 }).slice(0, 2);
}

/** SS58 address of a 32-byte public key (one-byte prefix), like wallet-core `dot_ss58_encode`. */
export function dotSs58Encode(pk: Uint8Array, prefix: number): string {
  const body = new Uint8Array([prefix & 0x3f, ...pk]);
  return base58.encode(new Uint8Array([...body, ...checksum(body)]));
}

/** `(prefix, public key)` or null (wallet-core `dot_ss58_decode`: 35 bytes, prefix < 64, checksum). */
export function dotSs58Decode(address: string): { prefix: number; pk: Uint8Array } | null {
  let raw: Uint8Array;
  try {
    raw = base58.decode(address.trim());
  } catch {
    return null;
  }
  if (raw.length !== 35 || (raw[0] ?? 64) >= 64) return null;
  const c = checksum(raw.slice(0, 33));
  if (raw[33] !== c[0] || raw[34] !== c[1]) return null;
  return { prefix: raw[0] ?? 0, pk: raw.slice(1, 33) };
}

/** Demo address of Polkadot account `account` (demo key, real SS58). */
export function demoDotAddress(seed: Uint8Array, account: number, network: Network): string {
  const pk = blake2b(new Uint8Array([...new TextEncoder().encode(`kyro-demo-dot/${account}`), ...seed]), { dkLen: 32 });
  return dotSs58Encode(pk, DOT_CHAINS[network === 'mainnet' ? 'mainnet' : 'testnet'].ss58);
}

const invalidInput = (m: string) => new IpcError('INVALID_INPUT', l10n(`Entrée invalide : ${m}`, `Invalid input: ${m}`));

interface DemoDotAccount {
  free: bigint;
  frozen: bigint;
  nonce: number;
}

/** Demo payload (hex JSON). */
interface DemoDotPayload {
  from: string;
  to: string;
  amount: string;
  nonce: number;
  birth: number;
  spec: number;
  signature?: string;
}

export interface DemoDotDeps {
  network: Network;
  seed: Uint8Array;
  tor: DemoTor;
  settings: () => Settings;
  requireUnlocked: () => void;
  checkPassword: (password: unknown) => void;
  confirm: (text: string) => boolean;
  now: () => number;
}

export interface DemoDotState {
  me: string;
  friend: string;
  accounts: Map<string, DemoDotAccount>;
  /** `from:nonce` → submit time. */
  submitted: Map<string, number>;
  /** `dot_txs` (mainnet only, like Statescan): a funding transfer, then the demo's sends. */
  history: DotHistoryEntry[];
}

export function createDemoDot(d: DemoDotDeps) {
  const c = DOT_CHAINS[d.network === 'mainnet' ? 'mainnet' : 'testnet'];
  const unit = 10n ** BigInt(c.decimals);
  const me = demoDotAddress(d.seed, 0, d.network);
  const friend = dotSs58Encode(blake2b(new TextEncoder().encode('kyro-demo-dot-friend'), { dkLen: 32 }), c.ss58);
  const t0 = d.now();
  const state: DemoDotState = {
    me,
    friend,
    accounts: new Map([
      // 12.5 free, 2 frozen (a governance lock).
      [me, { free: (125n * unit) / 10n, frozen: 2n * unit, nonce: 3 }],
      [friend, { free: 40n * unit, frozen: 0n, nonce: 17 }],
    ]),
    submitted: new Map(),
    history: [{ id: `0x${'d0'.repeat(32)}`, hash: `0x${'d0'.repeat(32)}`, chain: 'assetHub', blockHeight: 10_400_000, extrinsicIndex: 2, eventIndex: 4, time: t0 - 3 * 86_400_000, from: friend, to: me, amount: (15n * unit).toString(), direction: 'in' }],
  };
  const fee = (155n * unit) / 10_000n; // ≈ 0.0155
  const torOn = () => d.settings().tor.enabled;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const block = () => 9_400_000 + Math.floor((d.now() - t0) / BLOCK_MS);
  const backend = async () => {
    if (torOn()) await d.tor.waitReady();
    await wait(50 + Math.random() * 120);
  };
  const fmt = (v: bigint) => {
    const frac = (v % unit).toString().padStart(c.decimals, '0').replace(/0+$/, '');
    return `${v / unit}${frac ? `${decimalMark()}${frac}` : ''} ${c.symbol}`;
  };
  const checkAddress = (a: unknown): string => {
    const s = String(a ?? '').trim();
    const dec = dotSs58Decode(s);
    if (!dec) throw invalidInput(l10n('adresse Polkadot invalide', 'invalid Polkadot address'));
    if (dec.prefix !== c.ss58) {
      throw invalidInput(l10n(`adresse d'un autre réseau (préfixe SS58 ${dec.prefix}) : une adresse ${c.chain} commence par le préfixe ${c.ss58} (${c.ss58 === 0 ? '« 1… »' : '« 5… »'})`, `address from another network (SS58 prefix ${dec.prefix}): a ${c.chain} address starts with prefix ${c.ss58} (${c.ss58 === 0 ? '“1…”' : '“5…”'})`));
    }
    return s;
  };
  const account = (address: string): DotAccountInfo => {
    const a = state.accounts.get(address);
    if (!a) return { address, exists: false, free: '0', reserved: '0', frozen: '0', spendable: '0', nonce: 0, existentialDeposit: c.ed.toString() };
    const untouchable = a.frozen > c.ed ? a.frozen : c.ed;
    return {
      address,
      exists: a.free > 0n,
      free: a.free.toString(),
      reserved: '0',
      frozen: a.frozen.toString(),
      spendable: (a.free > untouchable ? a.free - untouchable : 0n).toString(),
      nonce: a.nonce,
      existentialDeposit: c.ed.toString(),
    };
  };
  const check = (ours: DotAccountInfo, dest: DotAccountInfo, value: bigint) => {
    if (!ours.exists) throw invalidInput(l10n(`ton compte n'existe pas encore sur la chaîne (aucun ${c.symbol} reçu)`, `your account does not exist on chain yet (no ${c.symbol} received)`));
    if (!dest.exists && value < c.ed) throw invalidInput(l10n(`ce compte n'existe pas encore : il faut lui envoyer au moins le dépôt existentiel (${fmt(c.ed)}), sinon le transfert échoue`, `this account does not exist yet: you must send it at least the existential deposit (${fmt(c.ed)}), otherwise the transfer fails`));
    const spendable = BigInt(ours.spendable);
    if (value + fee > spendable) throw invalidInput(l10n(`solde disponible insuffisant : ${fmt(spendable)} disponibles (solde − dépôt existentiel − part bloquée), il en faut ${fmt(value + fee)} avec les frais`, `insufficient available balance: ${fmt(spendable)} available (balance − existential deposit − locked part), ${fmt(value + fee)} needed with the fee`));
  };
  const view = (a: DotAccountInfo) => {
    const { existentialDeposit: _ed, ...rest } = a;
    return rest;
  };
  const contextFor = (to: string, birth: number): DotContext => ({
    account: view(account(me)),
    destination: view(account(to)),
    existentialDeposit: c.ed.toString(),
    fee: fee.toString(),
    eraBirth: birth,
    validUntil: birth + ERA_PERIOD,
    finalized: block(),
  });
  const encode = (p: DemoDotPayload) => bytesToHex(new TextEncoder().encode(JSON.stringify(p)));
  const decode = (hex: unknown): { p: DemoDotPayload; summary: DotTxSummary } => {
    let p: DemoDotPayload;
    try {
      p = JSON.parse(new TextDecoder().decode(hexToBytes(String(hex ?? '').trim().toLowerCase()))) as DemoDotPayload;
    } catch {
      throw invalidInput(l10n('transaction Polkadot refusée : hexadécimal attendu', 'Polkadot transaction refused: hexadecimal expected'));
    }
    if (p.from !== me) throw invalidInput(l10n("transaction Polkadot refusée : ce n'est pas ton compte", 'Polkadot transaction refused: this is not your account'));
    checkAddress(p.to);
    if (p.to === me) throw invalidInput(l10n('transaction Polkadot refusée : transfert à soi-même', 'Polkadot transaction refused: transfer to yourself'));
    if (!/^\d+$/.test(p.amount) || BigInt(p.amount) === 0n) throw invalidInput(l10n('transaction Polkadot refusée : montant nul', 'Polkadot transaction refused: zero amount'));
    if (p.spec !== c.spec) throw invalidInput(l10n('transaction Polkadot refusée : spec_version différent du runtime actuel : reconstruis', 'Polkadot transaction refused: spec_version differs from the current runtime: rebuild'));
    const summary: DotTxSummary = {
      chain: c.chain,
      from: me,
      to: p.to,
      amount: p.amount,
      symbol: c.symbol,
      decimals: c.decimals,
      call: 'Balances.transfer_keep_alive',
      nonce: p.nonce,
      tip: '0',
      eraPeriod: ERA_PERIOD,
      eraPhase: p.birth % ERA_PERIOD,
      blockHash: bytesToHex(blake2b(new TextEncoder().encode(`block:${p.birth}`), { dkLen: 32 })),
      specVersion: c.spec,
      txVersion: c.tx,
    };
    return { p, summary };
  };
  const describe = (s: DotTxSummary, ctx: DotContext) => {
    let out = l10n(`Envoi Polkadot — ${s.chain}${d.network === 'testnet' ? ' (testnet)' : ''}\n\nÀ : ${s.to}\n\nMontant : ${fmt(BigInt(s.amount))} (${s.amount} planck)\n`, `Polkadot send — ${s.chain}${d.network === 'testnet' ? ' (testnet)' : ''}\n\nTo: ${s.to}\n\nAmount: ${fmt(BigInt(s.amount))} (${s.amount} planck)\n`);
    if (!ctx.destination.exists) out += l10n(`Ce compte n'existe pas encore : ce transfert le crée (dépôt existentiel : ${fmt(c.ed)}).\n`, `This account does not exist yet: this transfer creates it (existential deposit: ${fmt(c.ed)}).\n`);
    out += l10n(`\nFrais estimés par le nœud : ≈ ${fmt(BigInt(ctx.fee))} (prélevés en plus)\nSolde : ${fmt(BigInt(ctx.account.free))} · bloqué : ${fmt(BigInt(ctx.account.frozen))} · dépôt existentiel (reste toujours sur le compte) : ${fmt(c.ed)} · disponible : ${fmt(BigInt(ctx.account.spendable))}\n`, `\nFee estimated by the node: ≈ ${fmt(BigInt(ctx.fee))} (charged on top)\nBalance: ${fmt(BigInt(ctx.account.free))} · locked: ${fmt(BigInt(ctx.account.frozen))} · existential deposit (always stays on the account): ${fmt(c.ed)} · available: ${fmt(BigInt(ctx.account.spendable))}\n`);
    out += l10n(`\nAppel : ${s.call} (ton compte reste actif) · pourboire : ${fmt(0n)}\nValable jusqu'au bloc n° ${ctx.validUntil} (${s.eraPeriod} blocs) · nonce ${s.nonce} · runtime ${s.specVersion} / ${s.txVersion}\n`, `\nCall: ${s.call} (your account stays alive) · tip: ${fmt(0n)}\nValid until block #${ctx.validUntil} (${s.eraPeriod} blocks) · nonce ${s.nonce} · runtime ${s.specVersion} / ${s.txVersion}\n`);
    return out;
  };
  const accountArg = (a: Record<string, unknown>) => {
    const n = a.account === undefined ? 0 : Number(a.account);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw invalidInput(l10n('numéro de compte : au plus 100', 'account number: at most 100'));
    return n;
  };

  const handlers: Record<Extract<keyof Commands, `dot_${string}`>, (a: Record<string, unknown>) => unknown> = {
    dot_backend_info: (): DotBackendInfo => ({ network: d.network === 'mainnet' ? 'mainnet' : 'testnet', chain: c.chain, symbol: c.symbol, decimals: c.decimals, ss58: c.ss58, label: c.host, tor: torOn() }),
    dot_address: (a) => {
      d.requireUnlocked();
      return demoDotAddress(d.seed, accountArg(a ?? {}), d.network);
    },
    dot_account: async (a) => {
      const addr = checkAddress(a.address);
      await backend();
      return account(addr);
    },
    dot_build_tx: async (a) => {
      d.requireUnlocked();
      const to = checkAddress(a.to);
      const amount = String(a.amount ?? '').trim();
      if (!/^\d+$/.test(amount) || BigInt(amount) === 0n) throw invalidInput(l10n('montant en planck invalide', 'invalid planck amount'));
      if (to === me) throw invalidInput(l10n('transfert à soi-même', 'transfer to yourself'));
      await backend();
      const birth = block();
      const ctx = contextFor(to, birth);
      check({ ...ctx.account, existentialDeposit: c.ed.toString() }, { ...ctx.destination, existentialDeposit: c.ed.toString() }, BigInt(amount));
      const payload = encode({ from: me, to, amount, nonce: ctx.account.nonce, birth, spec: c.spec });
      return { payload, summary: decode(payload).summary, context: ctx };
    },
    dot_sign_tx: async (a) => {
      d.requireUnlocked();
      const { p, summary } = decode(a.payload);
      await backend();
      if (block() + ERA_MARGIN >= p.birth + ERA_PERIOD) throw invalidInput(l10n('transaction Polkadot expirée (ou sur le point de l’être) : reconstruis-la', 'Polkadot transaction expired (or about to): rebuild it'));
      const ctx = contextFor(p.to, p.birth);
      if (ctx.account.nonce !== p.nonce) throw invalidInput(l10n('nonce périmé (une autre transaction est passée) : reconstruis la transaction', 'stale nonce (another transaction went through): rebuild the transaction'));
      check({ ...ctx.account, existentialDeposit: c.ed.toString() }, { ...ctx.destination, existentialDeposit: c.ed.toString() }, BigInt(p.amount));
      d.checkPassword(a.password);
      if (!d.confirm(l10n(`Confirmer l'envoi Polkadot\n${describe(summary, ctx)}`, `Confirm the Polkadot send\n${describe(summary, ctx)}`))) throw new IpcError('USER_REJECTED', l10n('Signature refusée.', 'Signature refused.'));
      const extrinsic = encode({ ...p, signature: bytesToHex(blake2b(new TextEncoder().encode(`sig:${String(a.payload)}`), { dkLen: 32 })) });
      return { extrinsic, hash: bytesToHex(blake2b(hexToBytes(extrinsic), { dkLen: 32 })), blockHash: summary.blockHash, summary, context: ctx };
    },
    dot_broadcast: async (a) => {
      const { p, summary } = decode(a.extrinsic);
      if (!p.signature) throw invalidInput(l10n('transaction Polkadot refusée : non signée', 'Polkadot transaction refused: not signed'));
      if (String(a.blockHash ?? '') !== summary.blockHash) throw invalidInput(l10n('transaction Polkadot refusée : signature invalide pour ce runtime, ce bloc et ce compte (rien n’est diffusé)', 'Polkadot transaction refused: invalid signature for this runtime, block and account (nothing is broadcast)'));
      await backend();
      const ours = state.accounts.get(me);
      if (!ours || ours.nonce !== p.nonce) throw invalidInput(l10n('transaction Polkadot refusée par le nœud (1010) : Invalid Transaction Transaction is outdated', 'Polkadot transaction refused by the node (1010): Invalid Transaction Transaction is outdated'));
      const value = BigInt(p.amount);
      ours.free -= value + fee;
      ours.nonce += 1;
      const dest = state.accounts.get(p.to);
      if (dest) dest.free += value;
      else state.accounts.set(p.to, { free: value, frozen: 0n, nonce: 0 });
      state.submitted.set(`${me}:${p.nonce}`, d.now());
      const hash = bytesToHex(blake2b(hexToBytes(String(a.extrinsic).trim().toLowerCase()), { dkLen: 32 }));
      state.history.unshift({ id: hash, hash, chain: 'assetHub', blockHeight: block(), extrinsicIndex: 2, eventIndex: 3, time: d.now(), from: me, to: p.to, amount: value.toString(), direction: p.to === me ? 'self' : 'out' });
      return hash;
    },
    dot_txs: async (a) => {
      checkAddress(a.address);
      if (d.network !== 'mainnet') return { available: false, partial: false, items: [] };
      await backend();
      return { available: true, partial: false, items: state.history.map((e) => ({ ...e })) };
    },
    // Tokens: none on the demo (Westend has no official stablecoin; mainnet demo holds none).
    dot_asset_balances: async (a) => {
      checkAddress(a.address);
      await backend();
      return [];
    },
    dot_build_asset_tx: () => Promise.reject(new IpcError('INVALID_INPUT', l10n('Démo : jetons Polkadot non simulés', 'Demo: Polkadot tokens are not simulated'))),
    dot_tx_status: async (a) => {
      const addr = checkAddress(a.address);
      await backend();
      const at = state.submitted.get(`${addr}:${Number(a.nonce)}`);
      const n = block();
      if (at !== undefined && d.now() - at >= FINALITY_MS) return { state: 'finalized', finalized: n };
      if (at === undefined && n >= Number(a.validUntil)) return { state: 'expired', finalized: n };
      return { state: 'pending', finalized: n };
    },
  };

  return { state, handlers };
}
