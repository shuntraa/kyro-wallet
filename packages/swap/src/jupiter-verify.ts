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

import { l10n } from '@kyro/shared';
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
  throw new SwapCheckError(l10n(`Jupiter : ${why} — transaction refusée, rien n’a été signé.`, `Jupiter: ${why} — transaction refused, nothing was signed.`));
};

async function ataBoth(owner: string, mint: string): Promise<string[]> {
  return [await associatedTokenAccount(owner, mint), await associatedTokenAccount(owner, mint, TOKEN_2022)];
}

/** Checks Jupiter's transaction against the swap the user reviewed. Throws `SwapCheckError`. */
export async function verifyJupiterSwap(i: JupiterCheckInput): Promise<JupiterCheck> {
  const s = i.summary;
  if (s.feePayer !== i.taker) fail(l10n('le payeur des frais n’est pas ton adresse', 'the fee payer is not your address'));
  if (s.signers.length !== 1 || s.signers[0] !== i.taker || s.ourSignerIndex !== 0) fail(l10n('un autre signataire est demandé', 'another signer is requested'));
  const bad = s.warnings.find((w) => w.kind === 'feePayerNotUs' || w.kind === 'extraWritableSigner' || w.kind === 'authorityNotUs' || w.kind === 'delegation');
  if (bad) fail(l10n(`avertissement du coffre (${bad.kind})`, `vault warning (${bad.kind})`));

  let ixs: Array<{ program: string; data: Uint8Array }>;
  try {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(i.wire));
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (!('instructions' in msg)) return fail(l10n('version de transaction non prise en charge', 'transaction version not supported'));
    ixs = msg.instructions.map((x: { programAddressIndex: number; data?: ArrayLike<number> }) => ({ program: String(msg.staticAccounts[x.programAddressIndex] ?? ''), data: new Uint8Array(x.data ?? []) }));
  } catch {
    return fail(l10n('transaction illisible', 'unreadable transaction'));
  }
  if (ixs.length !== s.instructions.length) fail(l10n('le décodage du coffre ne correspond pas à la transaction', 'the vault decoding does not match the transaction'));

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
        if (raw.program !== COMPUTE_BUDGET) fail(l10n(`${at} : programme inattendu`, `${at}: unexpected program`));
        continue;
      case 'ataCreate':
        if (raw.program !== ATA || ins.payer !== i.taker || ins.owner !== i.taker || !mints.has(ins.mint)) fail(l10n(`${at} : création d’un compte de token qui n’est pas à toi`, `${at}: creation of a token account that is not yours`));
        continue;
      case 'systemTransfer':
        if (raw.program !== SYSTEM || ins.from !== i.taker || ins.to !== wsolAta || i.sellMint !== WSOL_MINT) fail(l10n(`${at} : transfert de SOL vers ${ins.to}`, `${at}: SOL transfer to ${ins.to}`));
        continue;
      case 'unknown': {
        const keys = ins.accountKeys;
        if (raw.program !== ins.programId) fail(l10n(`${at} : programme incohérent`, `${at}: inconsistent program`));
        if (ins.programId === TOKEN || ins.programId === TOKEN_2022) {
          // SyncNative (17) on our wSOL account, CloseAccount (9) of it back to us: nothing else.
          if (raw.data.length === 1 && raw.data[0] === 17 && keys.length === 1 && keys[0] === wsolAta) continue;
          if (raw.data.length === 1 && raw.data[0] === 9 && keys.length === 3 && keys[0] === wsolAta && keys[1] === i.taker && keys[2] === i.taker) continue;
          fail(l10n(`${at} : instruction Token non autorisée`, `${at}: Token instruction not allowed`));
        }
        if (ins.programId !== JUPITER_V6) fail(l10n(`${at} : programme non autorisé (${ins.programId})`, `${at}: program not allowed (${ins.programId})`));
        if (route) fail(l10n('plusieurs instructions Jupiter', 'several Jupiter instructions'));
        route = checkRoute(raw.data, keys, i, sources, destinations);
        continue;
      }
      default:
        fail(l10n(`${at} : ${ins.type} non autorisé dans un swap`, `${at}: ${ins.type} not allowed in a swap`));
    }
  }
  if (!route) return fail(l10n('aucune instruction de swap Jupiter', 'no Jupiter swap instruction'));
  const priority = BigInt(s.priorityFeeLamports ?? '0');
  if (priority > JUPITER_MAX_PRIORITY_LAMPORTS) fail(l10n(`frais de priorité trop élevés (${priority} lamports)`, `priority fee too high (${priority} lamports)`));
  return { ...(route as JupiterCheck), priorityFeeLamports: priority };
}

function checkRoute(data: Uint8Array, keys: string[], i: JupiterCheckInput, sources: string[], destinations: string[]): JupiterCheck {
  const disc = hex(data.slice(0, 8));
  if (disc !== ROUTE && disc !== SHARED_ACCOUNTS_ROUTE) fail(l10n('instruction Jupiter inconnue de Kyro (route ou shared_accounts_route attendue)', 'Jupiter instruction unknown to Kyro (route or shared_accounts_route expected)'));
  if (data.length < 8 + 19) fail(l10n('instruction Jupiter tronquée', 'truncated Jupiter instruction'));
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
  if (authority !== i.taker) fail(l10n('l’autorité du swap n’est pas ton adresse', 'the swap authority is not your address'));
  if (!sources.includes(source)) fail(l10n('le compte débité n’est pas ton compte du token vendu', 'the debited account is not your account of the sold token'));
  if (!destinations.includes(destination)) fail(l10n('le compte crédité n’est pas ton compte du token acheté', 'the credited account is not your account of the bought token'));
  if (!shared && k(4) !== JUPITER_V6 && k(4) !== destination) fail(l10n('destination remplacée par un autre compte', 'destination replaced by another account'));
  if (shared && (k(7) !== i.sellMint || k(8) !== i.buyMint)) fail(l10n('tokens de la route différents de la paire', 'route tokens differ from the pair'));
  if (!shared && k(5) !== i.buyMint) fail(l10n('token reçu différent de celui demandé', 'received token differs from the requested one'));
  if (inAmount !== i.sellAmount) fail(l10n('montant vendu différent de ta saisie', 'sold amount differs from what you entered'));
  if (slippageBps !== i.slippageBps) fail(l10n('slippage différent de celui choisi', 'slippage differs from the one chosen'));
  if (quotedOut < i.quotedOut) fail(l10n('montant annoncé plus bas que le devis', 'announced amount lower than the quote'));
  if (i.fee) {
    if (platformFeeBps !== i.fee.bps) fail(l10n('frais Kyro à un autre taux', 'Kyro fees at another rate'));
    if (feeAccount !== i.fee.account) fail(l10n('frais Kyro versés à un autre compte', 'Kyro fees paid to another account'));
  } else if (platformFeeBps !== 0) fail(l10n('frais de plateforme inattendus', 'unexpected platform fees'));
  return { route: shared ? 'shared_accounts_route' : 'route', inAmount, quotedOut, slippageBps, platformFeeBps, priorityFeeLamports: 0n };
}
