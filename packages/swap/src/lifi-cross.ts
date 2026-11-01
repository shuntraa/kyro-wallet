// SPDX-License-Identifier: GPL-3.0-or-later
//
// LI.FI cross-chain from SOLANA (to EVM or Bitcoin), through NEAR Intents. li.quest returns the
// whole Solana transaction (`transactionRequest.data`, base64). Rust decodes it (`sol_decode_tx`)
// and this file accepts only the shape LI.FI builds for the `near` bridge (live transactions,
// 01/11/2026, SOL → ETH Arbitrum and USDC → USDC Base):
//
// - fee payer = the only signer = the taker (us); no warning other than the unknown LI.FI tracker;
// - ComputeBudget (priority fee capped), at most one LI.FI tracking instruction (`TrackV1`:
//   program 3i5Jeu… from LI.FI's `@lifi/solana-programs`, data = tag 0 + 8-byte id, accounts =
//   Clock sysvar + its epoch PDA, both read-only: it moves nothing);
// - transfers FROM US ONLY, of the sold token only (System transfers for SOL, SPL TransferChecked
//   from our token account for a token), to exactly three kinds of destination:
//     · the Kyro fee wallet (`recipients.solana`, or its token account) — > 0 and ≤ 0,7 %;
//     · LI.FI's fee wallet (34FKjA…, or its token account) — ≤ 0,5 %;
//     · ONE bridge deposit address (for a token: the token account of an owner created in the same
//       transaction), which NEAR Intents must then confirm (near-intents.ts): recipient = us…;
// - the transfers add up to exactly the amount sold; token account creation paid by us, for the
//   sold mint only.
//
// Rust shows an unknown instruction (the tracker), hence the reinforced 2nd window: the UI lists
// what Kyro checked above.

import type { SolTxSummary } from '@kyro/shared';
import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { associatedTokenAccount } from './providers/jupiter';
import { WSOL_MINT } from './providers/common';
import { JUPITER_MAX_PRIORITY_LAMPORTS } from './jupiter-verify';
import { SwapCheckError, maxKyroFee } from './verify';

/** LI.FI's Solana tracking program (`lifi-solana-program-1`, npm `@lifi/solana-programs` 0.1.12). */
export const LIFI_SOLANA_TRACKER = '3i5JeuZuUxeKtVysUnwQNGerJP2bSMX9fTFfS4Nxe3Br';
/**
 * Wallet LI.FI's own 0,25 % is paid to on Solana. Not documented by LI.FI: read in every live
 * transaction (01/11/2026; SOL directly, tokens to its associated token account). If LI.FI changes
 * it, Solana-source quotes are refused until this is updated (fail closed).
 */
export const LIFI_SOLANA_FEE_WALLET = '34FKjAdVcTax2DHqV2XnbXa9J3zmyKcFuFKWbcmgxjgm';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
/** LI.FI's own fee (0,25 %) + margin, like the EVM FeeForwarder cap. */
const LIFI_OWN_FEE_CAP_BPS = 50n;

export interface LifiSolanaCheckInput {
  wire: string;
  summary: SolTxSummary;
  taker: string;
  /** Mint sold (wSOL mint or `1111…` for native SOL). */
  sellMint: string;
  sellAmount: bigint;
  /** Kyro fee, null when off. `recipient` = the Solana fee WALLET. */
  fee: { bps: number; recipient: string } | null;
}

export interface LifiSolanaCheck {
  /** NEAR Intents deposit address (wallet; for a token, the owner of the credited token account). */
  depositAddress: string;
  /** Amount deposited (base units). */
  amountIn: bigint;
  kyroFee: bigint;
  lifiFee: bigint;
  priorityFeeLamports: bigint;
}

const fail = (why: string): never => {
  throw new SwapCheckError(`LI.FI : ${why} — transaction refusée, rien n’a été signé.`);
};

/** Rent of a token account (165 bytes), paid by us when the transaction creates one. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

/**
 * Network cost of a wire transaction, estimated for display: base fee per signature + priority
 * fee (ComputeBudget limit × price) + rent of every token account it creates. Null if unreadable.
 */
export function solWireCostLamports(wire: string): bigint | null {
  try {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (!('instructions' in msg)) return null;
    let limit = 200_000n;
    let price = 0n;
    let rent = 0n;
    for (const x of msg.instructions as Array<{ programAddressIndex: number; data?: ArrayLike<number> }>) {
      const program = String(msg.staticAccounts[x.programAddressIndex] ?? '');
      const d = new Uint8Array(x.data ?? []);
      const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
      if (program === COMPUTE_BUDGET && d[0] === 2 && d.length >= 5) limit = BigInt(view.getUint32(1, true));
      if (program === COMPUTE_BUDGET && d[0] === 3 && d.length >= 9) price = view.getBigUint64(1, true);
      if (program === ATA) rent += TOKEN_ACCOUNT_RENT_LAMPORTS;
    }
    return 5_000n * BigInt(msg.header.numSignerAccounts) + (limit * price + 999_999n) / 1_000_000n + rent;
  } catch {
    return null;
  }
}

/** Checks a Solana-source LI.FI (NEAR Intents) transaction. Throws `SwapCheckError`. */
export async function verifyLifiSolanaSource(i: LifiSolanaCheckInput): Promise<LifiSolanaCheck> {
  const s = i.summary;
  if (s.feePayer !== i.taker) fail('le payeur des frais n’est pas ton adresse');
  if (s.signers.length !== 1 || s.signers[0] !== i.taker || s.ourSignerIndex !== 0) fail('un autre signataire est demandé');
  const bad = s.warnings.find((w) => w.kind !== 'unknownInstruction' && w.kind !== 'priorityFeeEstimated');
  if (bad) fail(`avertissement du coffre (${bad.kind})`);

  let raw: Array<{ program: string; data: Uint8Array }>;
  try {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(i.wire));
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (!('instructions' in msg)) return fail('version de transaction non prise en charge');
    raw = msg.instructions.map((x: { programAddressIndex: number; data?: ArrayLike<number> }) => ({ program: String(msg.staticAccounts[x.programAddressIndex] ?? ''), data: new Uint8Array(x.data ?? []) }));
  } catch {
    return fail('transaction illisible');
  }
  if (raw.length !== s.instructions.length) fail('le décodage du coffre ne correspond pas à la transaction');

  const native = i.sellMint === WSOL_MINT || i.sellMint === SYSTEM;
  const ours = native ? [] : [await associatedTokenAccount(i.taker, i.sellMint), await associatedTokenAccount(i.taker, i.sellMint, TOKEN_2022)];
  const ataOf = async (owner: string) => (native ? [owner] : [await associatedTokenAccount(owner, i.sellMint), await associatedTokenAccount(owner, i.sellMint, TOKEN_2022)]);
  const kyroDest = i.fee ? await ataOf(i.fee.recipient) : [];
  const lifiDest = await ataOf(LIFI_SOLANA_FEE_WALLET);
  /** Owners of the token accounts created in this transaction (a deposit token account must be one of them). */
  const created = new Map<string, string>();
  let tracked = false;
  let kyro = 0n;
  let lifi = 0n;
  const deposits = new Map<string, bigint>();

  for (const [n, ins] of s.instructions.entries()) {
    const r = raw[n] as { program: string; data: Uint8Array };
    const at = `instruction ${n + 1}`;
    switch (ins.type) {
      case 'computeUnitLimit':
      case 'computeUnitPrice':
        if (r.program !== COMPUTE_BUDGET) fail(`${at} : programme inattendu`);
        continue;
      case 'ataCreate':
        if (native || r.program !== ATA || ins.payer !== i.taker || ins.mint !== i.sellMint) fail(`${at} : création d’un compte de token inattendue`);
        if (created.size >= 3) fail(`${at} : trop de comptes créés`);
        created.set(ins.account, ins.owner);
        continue;
      case 'systemTransfer': {
        if (!native || r.program !== SYSTEM || ins.from !== i.taker) fail(`${at} : transfert de SOL inattendu`);
        const v = BigInt(ins.lamports);
        if (kyroDest.includes(ins.to)) kyro += v;
        else if (lifiDest.includes(ins.to)) lifi += v;
        else deposits.set(ins.to, (deposits.get(ins.to) ?? 0n) + v);
        continue;
      }
      case 'tokenTransfer': {
        if (native || (r.program !== TOKEN && r.program !== TOKEN_2022)) fail(`${at} : transfert de token inattendu`);
        if (!ins.checked || ins.mint !== i.sellMint || ins.authority !== i.taker || !ours.includes(ins.source) || ins.multisigSigners.length > 0) fail(`${at} : transfert qui ne part pas de ton compte du token vendu`);
        const v = BigInt(ins.amount);
        if (kyroDest.includes(ins.destination)) kyro += v;
        else if (lifiDest.includes(ins.destination)) lifi += v;
        else {
          // A deposit token account must be the associated account of an owner created here.
          const owner = created.get(ins.destination);
          if (!owner || !(await ataOf(owner)).includes(ins.destination)) fail(`${at} : versement vers un compte de token inconnu`);
          deposits.set(owner as string, (deposits.get(owner as string) ?? 0n) + v);
        }
        continue;
      }
      case 'unknown': {
        if (r.program !== ins.programId) fail(`${at} : programme incohérent`);
        if (ins.programId !== LIFI_SOLANA_TRACKER) fail(`${at} : programme non autorisé (${ins.programId})`);
        // TrackV1: Borsh enum tag 0 + [u8; 8] transaction id; reads Clock + its epoch PDA.
        if (tracked || r.data.length !== 9 || r.data[0] !== 0 || ins.accountKeys.length !== 2 || ins.accountKeys[0] !== CLOCK || ins.accountKeys.includes(i.taker)) fail(`${at} : instruction de suivi LI.FI inattendue`);
        tracked = true;
        continue;
      }
      default:
        fail(`${at} : ${ins.type} non autorisé dans ce swap`);
    }
  }
  if (deposits.size !== 1) fail(deposits.size === 0 ? 'aucun dépôt vers le pont' : 'plusieurs destinataires inconnus');
  const [depositAddress, amountIn] = [...deposits.entries()][0] as [string, bigint];
  if (depositAddress === i.taker) fail('dépôt vers ta propre adresse');
  if (i.fee) {
    if (kyro <= 0n) fail('frais Kyro absents de la transaction');
    if (kyro > maxKyroFee(i.sellAmount, i.fee.bps)) fail('frais Kyro supérieurs au taux configuré');
  } else if (kyro !== 0n) fail('frais inattendus');
  if (lifi > (i.sellAmount * LIFI_OWN_FEE_CAP_BPS + 9_999n) / 10_000n) fail('frais LI.FI plus élevés que prévu');
  if (kyro + lifi + amountIn !== i.sellAmount) fail('montants envoyés différents du montant vendu');
  const priority = BigInt(s.priorityFeeLamports ?? '0');
  if (priority > JUPITER_MAX_PRIORITY_LAMPORTS) fail(`frais de priorité trop élevés (${priority} lamports)`);
  return { depositAddress, amountIn, kyroFee: kyro, lifiFee: lifi, priorityFeeLamports: priority };
}
