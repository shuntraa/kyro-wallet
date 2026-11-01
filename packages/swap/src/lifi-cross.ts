// SPDX-License-Identifier: GPL-3.0-or-later
//
// LI.FI cross-chain from Solana through NEAR Intents. Rust decodes the li.quest transaction; we accept
// only LI.FI's `near` bridge shape: we are the sole signer, at most one read-only `TrackV1` tracker,
// and transfers of the sold token from us only, to the Kyro fee wallet (exact rate), LI.FI's fee
// wallet (≤ 0,5 %) and one deposit address that NEAR Intents must confirm, summing to the amount sold.

import { l10n, type SolTxSummary } from '@kyro/shared';
import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { associatedTokenAccount } from './providers/jupiter';
import { WSOL_MINT } from './providers/common';
import { JUPITER_MAX_PRIORITY_LAMPORTS } from './jupiter-verify';
import { SwapCheckError, kyroFeeAtRate, maxKyroFee } from './verify';

/** LI.FI's Solana tracking program (`lifi-solana-program-1`, npm `@lifi/solana-programs` 0.1.12). */
export const LIFI_SOLANA_TRACKER = '3i5JeuZuUxeKtVysUnwQNGerJP2bSMX9fTFfS4Nxe3Br';
/** LI.FI's Solana fee wallet, undocumented (read from live txs). If it changes, quotes are refused (fail closed). */
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
  sellMint: string;
  sellAmount: bigint;
  /** Kyro fee, null when off. `recipient` = the Solana fee WALLET. */
  fee: { bps: number; recipient: string } | null;
}

export interface LifiSolanaCheck {
  /** NEAR Intents deposit address (wallet; for a token, the owner of the credited token account). */
  depositAddress: string;
  amountIn: bigint;
  kyroFee: bigint;
  lifiFee: bigint;
  priorityFeeLamports: bigint;
}

const fail = (why: string): never => {
  throw new SwapCheckError(l10n(`LI.FI : ${why} — transaction refusée, rien n’a été signé.`, `LI.FI: ${why} — transaction refused, nothing was signed.`));
};

/** Rent of a token account (165 bytes), paid by us when the transaction creates one. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

/** Estimated network cost: base fee + priority fee + rent of created token accounts. Null if unreadable. */
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
  if (s.feePayer !== i.taker) fail(l10n('le payeur des frais n’est pas ton adresse', 'the fee payer is not your address'));
  if (s.signers.length !== 1 || s.signers[0] !== i.taker || s.ourSignerIndex !== 0) fail(l10n('un autre signataire est demandé', 'another signer is requested'));
  const bad = s.warnings.find((w) => w.kind !== 'unknownInstruction' && w.kind !== 'priorityFeeEstimated');
  if (bad) fail(l10n(`avertissement du coffre (${bad.kind})`, `vault warning (${bad.kind})`));

  let raw: Array<{ program: string; data: Uint8Array }>;
  try {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(i.wire));
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (!('instructions' in msg)) return fail(l10n('version de transaction non prise en charge', 'transaction version not supported'));
    raw = msg.instructions.map((x: { programAddressIndex: number; data?: ArrayLike<number> }) => ({ program: String(msg.staticAccounts[x.programAddressIndex] ?? ''), data: new Uint8Array(x.data ?? []) }));
  } catch {
    return fail(l10n('transaction illisible', 'unreadable transaction'));
  }
  if (raw.length !== s.instructions.length) fail(l10n('le décodage du coffre ne correspond pas à la transaction', 'the vault decoding does not match the transaction'));

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
        if (r.program !== COMPUTE_BUDGET) fail(l10n(`${at} : programme inattendu`, `${at}: unexpected program`));
        continue;
      case 'ataCreate':
        if (native || r.program !== ATA || ins.payer !== i.taker || ins.mint !== i.sellMint) fail(l10n(`${at} : création d’un compte de token inattendue`, `${at}: unexpected token account creation`));
        if (created.size >= 3) fail(l10n(`${at} : trop de comptes créés`, `${at}: too many accounts created`));
        created.set(ins.account, ins.owner);
        continue;
      case 'systemTransfer': {
        if (!native || r.program !== SYSTEM || ins.from !== i.taker) fail(l10n(`${at} : transfert de SOL inattendu`, `${at}: unexpected SOL transfer`));
        const v = BigInt(ins.lamports);
        if (kyroDest.includes(ins.to)) kyro += v;
        else if (lifiDest.includes(ins.to)) lifi += v;
        else deposits.set(ins.to, (deposits.get(ins.to) ?? 0n) + v);
        continue;
      }
      case 'tokenTransfer': {
        if (native || (r.program !== TOKEN && r.program !== TOKEN_2022)) fail(l10n(`${at} : transfert de token inattendu`, `${at}: unexpected token transfer`));
        if (!ins.checked || ins.mint !== i.sellMint || ins.authority !== i.taker || !ours.includes(ins.source) || ins.multisigSigners.length > 0) fail(l10n(`${at} : transfert qui ne part pas de ton compte du token vendu`, `${at}: transfer that does not leave from your account of the sold token`));
        const v = BigInt(ins.amount);
        if (kyroDest.includes(ins.destination)) kyro += v;
        else if (lifiDest.includes(ins.destination)) lifi += v;
        else {
          // A deposit token account must be the associated account of an owner created here.
          const owner = created.get(ins.destination);
          if (!owner || !(await ataOf(owner)).includes(ins.destination)) fail(l10n(`${at} : versement vers un compte de token inconnu`, `${at}: payment to an unknown token account`));
          deposits.set(owner as string, (deposits.get(owner as string) ?? 0n) + v);
        }
        continue;
      }
      case 'unknown': {
        if (r.program !== ins.programId) fail(l10n(`${at} : programme incohérent`, `${at}: inconsistent program`));
        if (ins.programId !== LIFI_SOLANA_TRACKER) fail(l10n(`${at} : programme non autorisé (${ins.programId})`, `${at}: program not allowed (${ins.programId})`));
        // TrackV1: Borsh enum tag 0 + [u8; 8] transaction id; reads Clock + its epoch PDA.
        if (tracked || r.data.length !== 9 || r.data[0] !== 0 || ins.accountKeys.length !== 2 || ins.accountKeys[0] !== CLOCK || ins.accountKeys.includes(i.taker)) fail(l10n(`${at} : instruction de suivi LI.FI inattendue`, `${at}: unexpected LI.FI tracking instruction`));
        tracked = true;
        continue;
      }
      default:
        fail(l10n(`${at} : ${ins.type} non autorisé dans ce swap`, `${at}: ${ins.type} not allowed in this swap`));
    }
  }
  if (deposits.size !== 1) fail(deposits.size === 0 ? l10n('aucun dépôt vers le pont', 'no deposit to the bridge') : l10n('plusieurs destinataires inconnus', 'several unknown recipients'));
  const [depositAddress, amountIn] = [...deposits.entries()][0] as [string, bigint];
  if (depositAddress === i.taker) fail(l10n('dépôt vers ta propre adresse', 'deposit to your own address'));
  if (i.fee) {
    if (kyro <= 0n) fail(l10n('frais Kyro absents de la transaction', 'Kyro fees missing from the transaction'));
    if (kyro > maxKyroFee(i.sellAmount, i.fee.bps)) fail(l10n('frais Kyro supérieurs au taux configuré', 'Kyro fees above the configured rate'));
    if (!kyroFeeAtRate(kyro, i.sellAmount, i.fee.bps)) fail(l10n('frais Kyro différents du taux demandé', 'Kyro fees differ from the rate asked for'));
  } else if (kyro !== 0n) fail(l10n('frais inattendus', 'unexpected fees'));
  if (lifi > (i.sellAmount * LIFI_OWN_FEE_CAP_BPS + 9_999n) / 10_000n) fail(l10n('frais LI.FI plus élevés que prévu', 'LI.FI fees higher than expected'));
  if (kyro + lifi + amountIn !== i.sellAmount) fail(l10n('montants envoyés différents du montant vendu', 'amounts sent differ from the sold amount'));
  const priority = BigInt(s.priorityFeeLamports ?? '0');
  if (priority > JUPITER_MAX_PRIORITY_LAMPORTS) fail(l10n(`frais de priorité trop élevés (${priority} lamports)`, `priority fee too high (${priority} lamports)`));
  return { depositAddress, amountIn, kyroFee: kyro, lifiFee: lifi, priorityFeeLamports: priority };
}
