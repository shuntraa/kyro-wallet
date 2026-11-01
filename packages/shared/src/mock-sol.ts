// SPDX-License-Identifier: GPL-3.0-or-later
//
// DEMO ONLY — minimal TypeScript stand-in for wallet-core's `sol_decode_message`
// (crates/wallet-core/src/sol_decode.rs), enough for the messages Kyro's own
// adapter builds (System transfer, SPL Transfer/TransferChecked, ATA create,
// compute budget, memo) and the demo Jupiter transaction. Same summary rules
// as the Rust decoder; v0 lookup tables are refused (the real shell fetches them).

import { base58 } from '@scure/base';
import { IpcError, type SolInstruction, type SolTokenProgram, type SolTxSummary, type SolWarning } from './ipc';
import { l10n } from './i18n';

const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const MEMO_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
const MEMO_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const bad = (m: string) => new IpcError('INVALID_INPUT', l10n(`Message Solana invalide : ${m}`, `Invalid Solana message: ${m}`));

class Reader {
  private i = 0;
  constructor(private readonly b: Uint8Array) {}
  u8(): number {
    const v = this.b[this.i];
    if (v === undefined) throw bad(l10n('tronqué', 'truncated'));
    this.i += 1;
    return v;
  }
  bytes(n: number): Uint8Array {
    if (this.i + n > this.b.length) throw bad(l10n('tronqué', 'truncated'));
    const out = this.b.slice(this.i, this.i + n);
    this.i += n;
    return out;
  }
  shortvec(): number {
    let v = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const byte = this.u8();
      v |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return v;
    }
    throw bad(l10n('short-vec trop long', 'short-vec too long'));
  }
  peek(): number {
    const v = this.b[this.i];
    if (v === undefined) throw bad(l10n('tronqué', 'truncated'));
    return v;
  }
  done(): boolean {
    return this.i === this.b.length;
  }
}

const u64 = (d: Uint8Array, at: number): bigint => {
  if (d.length < at + 8) throw bad(l10n('données trop courtes', 'data too short'));
  return new DataView(d.buffer, d.byteOffset + at, 8).getBigUint64(0, true);
};
const u32 = (d: Uint8Array, at: number): number => {
  if (d.length < at + 4) throw bad(l10n('données trop courtes', 'data too short'));
  return new DataView(d.buffer, d.byteOffset + at, 4).getUint32(0, true);
};

function decodeInstruction(program: string, accounts: string[], data: Uint8Array): SolInstruction {
  const acc = (i: number) => {
    const a = accounts[i];
    if (a === undefined) throw bad(l10n('comptes manquants', 'missing accounts'));
    return a;
  };
  if (program === SYSTEM && data.length >= 4 && u32(data, 0) === 2) {
    return { type: 'systemTransfer', from: acc(0), to: acc(1), lamports: u64(data, 4).toString() };
  }
  if (program === TOKEN || program === TOKEN_2022) {
    const tokenProgram: SolTokenProgram = program === TOKEN ? 'token' : 'token2022';
    if (data[0] === 12 && data.length === 10) {
      return { type: 'tokenTransfer', tokenProgram, checked: true, source: acc(0), mint: acc(1), destination: acc(2), authority: acc(3), amount: u64(data, 1).toString(), decimals: data[9] ?? 0, multisigSigners: accounts.slice(4) };
    }
    if (data[0] === 3 && data.length === 9) {
      return { type: 'tokenTransfer', tokenProgram, checked: false, source: acc(0), mint: null, destination: acc(1), authority: acc(2), amount: u64(data, 1).toString(), decimals: null, multisigSigners: accounts.slice(3) };
    }
  }
  if (program === ATA && (data.length === 0 || (data.length === 1 && (data[0] === 0 || data[0] === 1)))) {
    return { type: 'ataCreate', idempotent: data[0] === 1, payer: acc(0), account: acc(1), owner: acc(2), mint: acc(3), tokenProgram: accounts[5] ?? null };
  }
  if (program === COMPUTE_BUDGET && data[0] === 2 && data.length === 5) return { type: 'computeUnitLimit', units: u32(data, 1) };
  if (program === COMPUTE_BUDGET && data[0] === 3 && data.length === 9) return { type: 'computeUnitPrice', microLamports: u64(data, 1).toString() };
  if (program === MEMO_V1 || program === MEMO_V2) return { type: 'memo', text: new TextDecoder().decode(data).slice(0, 566) };
  return { type: 'unknown', programId: program, accounts: accounts.length, accountKeys: accounts, dataLen: data.length };
}

export function demoDecodeSolMessage(message: Uint8Array, ourAddress: string): SolTxSummary {
  const r = new Reader(message);
  let v0 = false;
  if (r.peek() & 0x80) {
    const version = r.u8() & 0x7f;
    if (version !== 0) throw bad(l10n(`version ${version} non prise en charge`, `version ${version} not supported`));
    v0 = true;
  }
  const numSigners = r.u8();
  const numReadonlySigned = r.u8();
  r.u8(); // numReadonlyUnsigned
  const keys = Array.from({ length: r.shortvec() }, () => base58.encode(r.bytes(32)));
  if (numSigners === 0 || numSigners > keys.length) throw bad(l10n('en-tête incohérent', 'inconsistent header'));
  const blockhash = base58.encode(r.bytes(32));
  const raw = Array.from({ length: r.shortvec() }, () => {
    const programIndex = r.u8();
    const accountIdx = Array.from({ length: r.shortvec() }, () => r.u8());
    const data = r.bytes(r.shortvec());
    return { programIndex, accountIdx, data };
  });
  if (v0 && r.shortvec() > 0) throw bad(l10n('tables d’adresses non prises en charge en mode démo', 'address lookup tables not supported in demo mode'));
  if (!r.done()) throw bad(l10n('octets en trop', 'extra bytes'));
  const key = (i: number) => {
    const k = keys[i];
    if (k === undefined) throw bad(l10n('index de compte hors limites', 'account index out of range'));
    return k;
  };
  const instructions = raw.map((x) => decodeInstruction(key(x.programIndex), x.accountIdx.map(key), x.data));

  const signers = keys.slice(0, numSigners);
  const feePayer = signers[0] ?? '';
  const idx = signers.indexOf(ourAddress);
  const warnings: SolWarning[] = [];
  let extra = false;
  if (feePayer !== ourAddress) {
    warnings.push({ kind: 'feePayerNotUs', feePayer });
    extra = true;
  }
  for (const s of signers.slice(0, numSigners - numReadonlySigned)) {
    if (s !== ourAddress) {
      warnings.push({ kind: 'extraWritableSigner', address: s });
      extra = true;
    }
  }
  let limit: number | null = null;
  let price: bigint | null = null;
  let nonBudget = 0n;
  instructions.forEach((ins, i) => {
    const authority = ins.type === 'systemTransfer' ? ins.from : ins.type === 'tokenTransfer' ? ins.authority : null;
    if (authority !== null && authority !== ourAddress) {
      warnings.push({ kind: 'authorityNotUs', instruction: i, authority });
      extra = true;
    }
    if (ins.type === 'tokenTransfer' && ins.tokenProgram === 'token2022') warnings.push({ kind: 'token2022ExtensionsUnverified', instruction: i });
    if (ins.type === 'unknown') {
      warnings.push({ kind: 'unknownInstruction', instruction: i, programId: ins.programId });
      extra = true;
    }
    if (ins.type === 'computeUnitLimit') limit = ins.units;
    else if (ins.type === 'computeUnitPrice') price = BigInt(ins.microLamports);
    else nonBudget += 1n;
  });
  let priority: string | null = null;
  if (price !== null) {
    let lim: bigint;
    if (limit !== null) lim = BigInt(Math.min(limit, 1_400_000));
    else {
      warnings.push({ kind: 'priorityFeeEstimated' });
      lim = nonBudget * 200_000n > 1_400_000n ? 1_400_000n : nonBudget * 200_000n;
    }
    priority = ((BigInt(price) * lim + 999_999n) / 1_000_000n).toString();
  }
  return {
    version: v0 ? 'v0' : 'legacy',
    feePayer,
    signers,
    ourSignerIndex: idx >= 0 ? idx : null,
    recentBlockhash: blockhash,
    instructions,
    lookupTables: [],
    baseFeeLamports: (5000n * BigInt(numSigners)).toString(),
    computeUnitLimit: limit,
    computeUnitPriceMicroLamports: price === null ? null : String(price),
    priorityFeeLamports: priority,
    warnings,
    requiresExtraConfirmation: extra,
  };
}

/** One line per instruction, for the simulated native dialog. */
export function demoSolSummaryText(s: SolTxSummary): string {
  const lines = s.instructions.map((i) => {
    switch (i.type) {
      case 'systemTransfer':
        return l10n(`Envoyer ${i.lamports} lamports à ${i.to}`, `Send ${i.lamports} lamports to ${i.to}`);
      case 'tokenTransfer':
        return l10n(`Envoyer ${i.amount} (unités de base) du token ${i.mint ?? '?'} vers le compte ${i.destination}`, `Send ${i.amount} (base units) of token ${i.mint ?? '?'} to account ${i.destination}`);
      case 'ataCreate':
        return l10n(`Créer le compte de token de ${i.owner} (payé par ${i.payer})`, `Create the token account of ${i.owner} (paid by ${i.payer})`);
      case 'computeUnitLimit':
        return l10n(`Limite de calcul : ${i.units} CU`, `Compute limit: ${i.units} CU`);
      case 'computeUnitPrice':
        return l10n(`Priority fee : ${i.microLamports} µL/CU`, `Priority fee: ${i.microLamports} µL/CU`);
      case 'memo':
        return l10n(`Mémo : ${i.text}`, `Memo: ${i.text}`);
      case 'unknown':
        return l10n(`Instruction NON RECONNUE (${i.programId})`, `UNRECOGNIZED instruction (${i.programId})`);
      default:
        return i.type;
    }
  });
  return l10n(`${lines.join('\n')}\nFrais de base : ${s.baseFeeLamports} lamports${s.priorityFeeLamports ? ` + priorité ${s.priorityFeeLamports}` : ''}`, `${lines.join('\n')}\nBase fee: ${s.baseFeeLamports} lamports${s.priorityFeeLamports ? ` + priority ${s.priorityFeeLamports}` : ''}`);
}
