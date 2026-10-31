// SPDX-License-Identifier: GPL-3.0-or-later
//
// What Kyro checks in Jupiter's `swapTransaction` before asking for the password. Jupiter builds
// the whole Solana transaction; Rust decodes it (`sol_decode_tx`, tables included) but sees the
// Jupiter route and the Token wrap/unwrap instructions as « unknown ». So, on top of the Rust
// summary (resolved accounts), the TypeScript side reads each instruction's DATA from the wire
// transaction and accepts only this shape:
//
// - fee payer = the only signer = the taker (us);
// - programs: ComputeBudget, the ATA program (creating OUR token accounts of the pair's mints),
//   System (only to wrap SOL into OUR wSOL account), Token / Token-2022 SyncNative on that
//   account and CloseAccount of it back to us, and exactly ONE Jupiter v6 `route` or
//   `shared_accounts_route` instruction;
// - no token transfer, approval, account creation or SOL transfer to anyone else;
// - the route: our transfer authority, source = our account of the sold mint, destination = our
//   account of the bought mint, in_amount = the amount sold, slippage = the one chosen, platform
//   fee = the Kyro rate paid into the expected Kyro fee account (none when the fee is off);
// - a capped priority fee.
//
// Layout of the two route instructions: Jupiter v6 IDL (accounts and trailing
// `in_amount u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u8`), checked against
// two live lite-api.jup.ag transactions (01/11/2026, USDC → SOL and SOL → USDC).

import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import type { SolTxSummary } from '@kyro/shared';
import { associatedTokenAccount } from './providers/jupiter';
import { WSOL_MINT } from './providers/common';
import { SwapCheckError } from './verify';

export const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** Anchor discriminators: sha256("global:route")[0..8], sha256("global:shared_accounts_route")[0..8]. */
const ROUTE = 'e517cb977ae3ad2a';
const SHARED_ACCOUNTS_ROUTE = 'c1209b3341d69c81';

/** Most priority fee accepted for a swap (lamports): 0,01 SOL. */
export const JUPITER_MAX_PRIORITY_LAMPORTS = 10_000_000n;

export interface JupiterCheckInput {
  /** Base64 wire transaction from /swap. */
  wire: string;
  /** Rust's decoding of the same message (`sol_decode_tx`). */
  summary: SolTxSummary;
  taker: string;
  sellMint: string;
  buyMint: string;
  sellAmount: bigint;
  slippageBps: number;
  /** `outAmount` of the quote. */
  quotedOut: bigint;
  /** Kyro fee: bps and the token account it must be paid into, or null when off. */
  fee: { bps: number; account: string } | null;
}

export interface JupiterCheck {
  route: 'route' | 'shared_accounts_route';
  inAmount: bigint;
  quotedOut: bigint;
  slippageBps: number;
  platformFeeBps: number;
  priorityFeeLamports: bigint;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const u64 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true);
const u16 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset + at, 2).getUint16(0, true);
const fail = (why: string): never => {
  throw new SwapCheckError(`Jupiter : ${why} — transaction refusée, rien n’a été signé.`);
};

async function ataBoth(owner: string, mint: string): Promise<string[]> {
  return [await associatedTokenAccount(owner, mint), await associatedTokenAccount(owner, mint, TOKEN_2022)];
}

/** Checks Jupiter's transaction against the swap the user reviewed. Throws `SwapCheckError`. */
export async function verifyJupiterSwap(i: JupiterCheckInput): Promise<JupiterCheck> {
  const s = i.summary;
  if (s.feePayer !== i.taker) fail('le payeur des frais n’est pas ton adresse');
  if (s.signers.length !== 1 || s.signers[0] !== i.taker || s.ourSignerIndex !== 0) fail('un autre signataire est demandé');
  const bad = s.warnings.find((w) => w.kind === 'feePayerNotUs' || w.kind === 'extraWritableSigner' || w.kind === 'authorityNotUs' || w.kind === 'delegation');
  if (bad) fail(`avertissement du coffre (${bad.kind})`);

  let ixs: Array<{ program: string; data: Uint8Array }>;
  try {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(i.wire));
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (!('instructions' in msg)) return fail('version de transaction non prise en charge');
    ixs = msg.instructions.map((x: { programAddressIndex: number; data?: ArrayLike<number> }) => ({ program: String(msg.staticAccounts[x.programAddressIndex] ?? ''), data: new Uint8Array(x.data ?? []) }));
  } catch {
    return fail('transaction illisible');
  }
  if (ixs.length !== s.instructions.length) fail('le décodage du coffre ne correspond pas à la transaction');

  const wsolAta = await associatedTokenAccount(i.taker, WSOL_MINT);
  const sources = await ataBoth(i.taker, i.sellMint);
  const destinations = await ataBoth(i.taker, i.buyMint);
  const mints = new Set([i.sellMint, i.buyMint, WSOL_MINT]);
  let route: JupiterCheck | null = null;

  for (const [n, ins] of s.instructions.entries()) {
    const raw = ixs[n] as { program: string; data: Uint8Array };
    const at = `instruction ${n + 1}`;
    switch (ins.type) {
      case 'computeUnitLimit':
      case 'computeUnitPrice':
        if (raw.program !== COMPUTE_BUDGET) fail(`${at} : programme inattendu`);
        continue;
      case 'ataCreate':
        if (raw.program !== ATA || ins.payer !== i.taker || ins.owner !== i.taker || !mints.has(ins.mint)) fail(`${at} : création d’un compte de token qui n’est pas à toi`);
        continue;
      case 'systemTransfer':
        if (raw.program !== SYSTEM || ins.from !== i.taker || ins.to !== wsolAta || i.sellMint !== WSOL_MINT) fail(`${at} : transfert de SOL vers ${ins.to}`);
        continue;
      case 'unknown': {
        const keys = ins.accountKeys;
        if (raw.program !== ins.programId) fail(`${at} : programme incohérent`);
        if (ins.programId === TOKEN || ins.programId === TOKEN_2022) {
          // SyncNative (17) on our wSOL account, CloseAccount (9) of it back to us: nothing else.
          if (raw.data.length === 1 && raw.data[0] === 17 && keys.length === 1 && keys[0] === wsolAta) continue;
          if (raw.data.length === 1 && raw.data[0] === 9 && keys.length === 3 && keys[0] === wsolAta && keys[1] === i.taker && keys[2] === i.taker) continue;
          fail(`${at} : instruction Token non autorisée`);
        }
        if (ins.programId !== JUPITER_V6) fail(`${at} : programme non autorisé (${ins.programId})`);
        if (route) fail('plusieurs instructions Jupiter');
        route = checkRoute(raw.data, keys, i, sources, destinations);
        continue;
      }
      default:
        fail(`${at} : ${ins.type} non autorisé dans un swap`);
    }
  }
  if (!route) return fail('aucune instruction de swap Jupiter');
  const priority = BigInt(s.priorityFeeLamports ?? '0');
  if (priority > JUPITER_MAX_PRIORITY_LAMPORTS) fail(`frais de priorité trop élevés (${priority} lamports)`);
  return { ...(route as JupiterCheck), priorityFeeLamports: priority };
}

function checkRoute(data: Uint8Array, keys: string[], i: JupiterCheckInput, sources: string[], destinations: string[]): JupiterCheck {
  const disc = hex(data.slice(0, 8));
  if (disc !== ROUTE && disc !== SHARED_ACCOUNTS_ROUTE) fail('instruction Jupiter inconnue de Kyro (route ou shared_accounts_route attendue)');
  if (data.length < 8 + 19) fail('instruction Jupiter tronquée');
  const t = data.length - 19;
  const inAmount = u64(data, t);
  const quotedOut = u64(data, t + 8);
  const slippageBps = u16(data, t + 16);
  const platformFeeBps = data[t + 18] ?? 0;
  const shared = disc === SHARED_ACCOUNTS_ROUTE;
  // route: token_program, user_transfer_authority, source, destination, destination_token_account?, destination_mint, platform_fee_account?, …
  // shared_accounts_route: token_program, program_authority, user_transfer_authority, source, program_source, program_destination, destination, source_mint, destination_mint, platform_fee_account?, …
  const k = (n: number) => keys[n] ?? '';
  const authority = shared ? k(2) : k(1);
  const source = shared ? k(3) : k(2);
  const destination = shared ? k(6) : k(3);
  const feeAccount = shared ? k(9) : k(6);
  if (authority !== i.taker) fail('l’autorité du swap n’est pas ton adresse');
  if (!sources.includes(source)) fail('le compte débité n’est pas ton compte du token vendu');
  if (!destinations.includes(destination)) fail('le compte crédité n’est pas ton compte du token acheté');
  if (!shared && k(4) !== JUPITER_V6 && k(4) !== destination) fail('destination remplacée par un autre compte');
  if (shared && (k(7) !== i.sellMint || k(8) !== i.buyMint)) fail('tokens de la route différents de la paire');
  if (!shared && k(5) !== i.buyMint) fail('token reçu différent de celui demandé');
  if (inAmount !== i.sellAmount) fail('montant vendu différent de ta saisie');
  if (slippageBps !== i.slippageBps) fail('slippage différent de celui choisi');
  if (quotedOut < i.quotedOut) fail('montant annoncé plus bas que le devis');
  if (i.fee) {
    if (platformFeeBps !== i.fee.bps) fail('frais Kyro à un autre taux');
    if (feeAccount !== i.fee.account) fail('frais Kyro versés à un autre compte');
  } else if (platformFeeBps !== 0) fail('frais de plateforme inattendus');
  return { route: shared ? 'shared_accounts_route' : 'route', inAmount, quotedOut, slippageBps, platformFeeBps, priorityFeeLamports: 0n };
}
