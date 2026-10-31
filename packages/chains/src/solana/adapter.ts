// SPDX-License-Identifier: GPL-3.0-or-later
//
// Solana adapter. Messages are built with @solana/kit. Rust decodes them
// (`sol_decode_tx`, shown before the password) and signs them (`sol_sign_tx`,
// native dialog); the UI places the signature at `summary.ourSignerIndex`.
// SPL sends: TransferChecked (Token or Token-2022, program read from the mint
// owner, decimals read on-chain), recipient ATA created idempotently if absent.

import { accountArg } from '../types';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  isAddress,
  isOffCurveAddress,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type SignatureBytes,
  type Transaction,
} from '@solana/kit';
import { call, jsonRpc, netFetch, type NetFetch, type SolTxSummary } from '@kyro/shared';
import { SPL_TOKENS, type SolChain } from '../registry';
import { feeCost } from '../fees';
import { formatUnits } from '../units';
import type { HwSigner } from '../hw';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem, SolSigned, SolUnsigned } from '../types';

export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** System transfer (~150 CU) + 2 compute-budget instructions (~150 CU each), with margin. */
export const SOL_TRANSFER_CU = 600;
/** Token account sizes: legacy 165 bytes; Token-2022 ATA carries the ImmutableOwner extension (170). */
export const TOKEN_ACCOUNT_SIZE = { token: 165, token2022: 170 } as const;

/** Compute-unit limit for an SPL send (TransferChecked ≈ 6k CU, ATA create ≈ 25k CU; Token-2022 costs more). */
export function splComputeUnits(createsAta: boolean, token2022: boolean): number {
  const base = token2022 ? 20_000 : 10_000;
  return base + (createsAta ? (token2022 ? 60_000 : 30_000) : 0);
}

export interface SolanaAdapterOptions {
  chain: SolChain;
  address: string;
  rpcUrl?: string;
  fetch?: NetFetch;
  /** Hardware-wallet account (signing through `hw_sign_sol_tx`). */
  hw?: HwSigner;
  /** Vault account (docs/IPC.md §2.9) passed to every signing command; absent = 0. */
  account?: number;
}

interface RpcCtx<T> {
  context: { slot: number };
  value: T;
}
interface RpcAccount {
  owner: string;
  lamports: number;
  data: [string, string] | { parsed: unknown };
  executable?: boolean;
}

/**
 * Why this recipient would lose the funds, or null. Kyro sends to WALLETS only:
 * - an address off the ed25519 curve (a PDA, owned by a program: nobody signs for it);
 * - a program (executable account);
 * - a token account or a mint (owned by the Token programs): native SOL sent there is stuck, and
 *   a token sent to the ATA of a token account is unreachable.
 */
export function solanaRecipientProblem(recipient: string, acc: Pick<RpcAccount, 'owner' | 'executable'> | null): string | null {
  if (!isAddress(recipient)) return 'Adresse Solana invalide.';
  if (isOffCurveAddress(address(recipient))) return 'Cette adresse est dérivée d’un programme (PDA), pas un portefeuille : personne ne peut signer pour elle, les fonds seraient perdus. Demande l’adresse du portefeuille.';
  if (acc?.executable) return 'Cette adresse est un programme, pas un portefeuille : les fonds seraient perdus.';
  if (acc && (acc.owner === TOKEN_PROGRAM || acc.owner === TOKEN_2022_PROGRAM)) return 'Cette adresse est un compte de token ou un mint, pas un portefeuille : les fonds y seraient bloqués. Demande l’adresse du portefeuille.';
  return null;
}
interface ParsedTokenAccount {
  pubkey: string;
  account: { owner: string; data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } };
}

/** SystemProgram::Transfer (index 2, u64 LE lamports). */
export function systemTransferInstruction(from: Address, to: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

/** SPL Token / Token-2022 `TransferChecked` (12): [12, amount u64 LE, decimals u8]. */
export function transferCheckedInstruction(p: { source: Address; mint: Address; destination: Address; authority: Address; amount: bigint; decimals: number; tokenProgram: Address }): Instruction {
  if (!Number.isInteger(p.decimals) || p.decimals < 0 || p.decimals > 255) throw new Error('Décimales invalides');
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, p.amount, true);
  data[9] = p.decimals;
  return {
    programAddress: p.tokenProgram,
    accounts: [
      { address: p.source, role: AccountRole.WRITABLE },
      { address: p.mint, role: AccountRole.READONLY },
      { address: p.destination, role: AccountRole.WRITABLE },
      { address: p.authority, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };
}

/** Associated Token Account program `CreateIdempotent` (1). */
export function createAtaIdempotentInstruction(p: { payer: Address; ata: Address; owner: Address; mint: Address; tokenProgram: Address }): Instruction {
  return {
    programAddress: ATA_PROGRAM,
    accounts: [
      { address: p.payer, role: AccountRole.WRITABLE_SIGNER },
      { address: p.ata, role: AccountRole.WRITABLE },
      { address: p.owner, role: AccountRole.READONLY },
      { address: p.mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: p.tokenProgram, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([1]),
  };
}

/** ATA = PDA(ATA program, [owner, token program, mint]). */
export async function findAssociatedTokenAddress(owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM): Promise<Address> {
  const enc = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [enc.encode(owner), enc.encode(tokenProgram), enc.encode(mint)] });
  return ata;
}

/** Read program + decimals from a mint account (base64 data, owner = token program). */
export function parseMintAccount(account: RpcAccount | null): { tokenProgram: Address; decimals: number } {
  if (!account) throw new Error('Mint introuvable sur ce réseau');
  if (account.owner !== TOKEN_PROGRAM && account.owner !== TOKEN_2022_PROGRAM) throw new Error('Ce compte n’est pas un mint SPL');
  if (!Array.isArray(account.data) || account.data[1] !== 'base64') throw new Error('Données du mint illisibles');
  const bytes = getBase64Encoder().encode(account.data[0]);
  // Mint layout: COption<Pubkey> authority (36) · supply u64 (8) · decimals u8 · is_initialized u8 …
  if (bytes.length < 82 || bytes[45] !== 1) throw new Error('Mint non initialisé');
  return { tokenProgram: address(account.owner), decimals: bytes[44] ?? 0 };
}

/**
 * Put our signature in the slot `index` of the transaction's ordered signature
 * map, after checking that this slot belongs to `expected`.
 */
export function placeSignature(tx: Transaction, index: number, signature: SignatureBytes, expected: string): Transaction {
  const entries = Object.entries(tx.signatures) as Array<[Address, SignatureBytes | null]>;
  const slot = entries[index];
  if (!slot) throw new Error(`Index de signature ${index} hors limites (${entries.length} signataires)`);
  if (slot[0] !== expected) throw new Error('L’index de signature ne correspond pas à notre adresse');
  if (signature.length !== 64) throw new Error('Signature Solana invalide');
  const next = entries.map(([k, v], i): [Address, SignatureBytes | null] => [k, i === index ? signature : v]);
  return { ...tx, signatures: Object.fromEntries(next) as Transaction['signatures'] };
}

/**
 * Cross-check the Rust decoding against what the UI built. Returns a French
 * error message when something differs (the send must then be blocked).
 */
export function checkSolSummary(u: SolUnsigned, s: SolTxSummary, me: string): string | null {
  if (s.ourSignerIndex === null) return 'Ton adresse ne signe pas cette transaction.';
  if (s.feePayer !== me) return 'Le payeur des frais n’est pas ton adresse.';
  const extra = s.instructions.filter((i) => i.type !== 'computeUnitLimit' && i.type !== 'computeUnitPrice');
  if (!u.mint) {
    const t = extra[0];
    if (extra.length !== 1 || t?.type !== 'systemTransfer') return 'Le décodage ne montre pas un simple transfert de SOL.';
    if (t.to !== u.recipient || t.lamports !== u.amount.toString() || t.from !== me) return 'Destinataire ou montant décodé différent de ta saisie.';
    return null;
  }
  const transfers = extra.filter((i) => i.type === 'tokenTransfer');
  const creates = extra.filter((i) => i.type === 'ataCreate');
  if (transfers.length !== 1 || extra.length !== transfers.length + creates.length) return 'Le décodage contient des instructions inattendues.';
  const t = transfers[0];
  if (t?.type !== 'tokenTransfer' || !t.checked || t.mint !== u.mint || t.destination !== u.destinationTokenAccount || t.amount !== u.amount.toString() || t.authority !== me) {
    return 'Transfert de token décodé différent de ta saisie (mint, compte destinataire ou montant).';
  }
  if (creates.length !== (u.createsAta ? 1 : 0)) return 'Création de compte de token inattendue.';
  const c = creates[0];
  if (c?.type === 'ataCreate' && (c.owner !== u.recipient || c.account !== u.destinationTokenAccount || c.mint !== u.mint || c.payer !== me)) return 'Création de compte de token incohérente.';
  return null;
}

export class SolanaAdapter implements ChainAdapter<'sol'> {
  readonly family = 'sol' as const;
  readonly chain: SolChain;
  readonly rpcUrl: string;
  latencyMs: number | null = null;
  private readonly me: Address;
  private readonly fetcher: NetFetch;
  readonly hw: HwSigner | null;
  /** Vault account index (`m/44'/501'/i'/0'`). */
  readonly account: number;

  constructor(opts: SolanaAdapterOptions) {
    if (!isAddress(opts.address)) throw new Error('Adresse Solana du coffre invalide');
    this.chain = opts.chain;
    this.me = address(opts.address);
    this.fetcher = opts.fetch ?? netFetch;
    this.rpcUrl = opts.rpcUrl || opts.chain.rpcUrl;
    this.hw = opts.hw ?? null;
    this.account = opts.account ?? 0;
  }

  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const t0 = performance.now();
    try {
      return await jsonRpc<T>(this.fetcher, this.rpcUrl, method, params);
    } finally {
      this.latencyMs = Math.round(performance.now() - t0);
    }
  }

  getAddress(): string {
    return this.me;
  }

  isValidAddress(a: string): boolean {
    return isAddress(a.trim());
  }

  async slot(): Promise<number> {
    return this.rpc<number>('getSlot', [{ commitment: 'confirmed' }]);
  }

  private accountInfo(addr: string): Promise<RpcAccount | null> {
    return this.rpc<RpcCtx<RpcAccount | null>>('getAccountInfo', [addr, { encoding: 'base64', commitment: 'confirmed' }]).then((r) => r.value);
  }

  private async lamports(): Promise<bigint> {
    const bal = await this.rpc<RpcCtx<number>>('getBalance', [this.me, { commitment: 'confirmed' }]);
    return BigInt(bal.value);
  }

  async getBalance(): Promise<Balance[]> {
    const tokenAccounts = (programId: string) =>
      this.rpc<RpcCtx<ParsedTokenAccount[]>>('getTokenAccountsByOwner', [this.me, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
        .then((r) => r.value)
        .catch(() => [] as ParsedTokenAccount[]);
    const [lamports, legacy, t22] = await Promise.all([this.lamports(), tokenAccounts(TOKEN_PROGRAM), tokenAccounts(TOKEN_2022_PROGRAM)]);
    const all = [...legacy, ...t22];
    const out: Balance[] = [{ assetId: 'sol', amount: lamports }];
    for (const t of SPL_TOKENS[this.chain.network]) {
      const amount = all.filter((a) => a.account.data.parsed.info.mint === t.contract).reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
      out.push({ assetId: `spl:${t.contract}`, amount });
    }
    return out;
  }

  async estimateFees(): Promise<FeeEstimates> {
    let fees: number[] = [];
    try {
      const r = await this.rpc<Array<{ prioritizationFee: number }>>('getRecentPrioritizationFees', [[this.me]]);
      fees = r.map((x) => x.prioritizationFee).sort((a, b) => a - b);
    } catch {
      fees = [];
    }
    const q = (p: number) => BigInt(Math.round(fees.length ? (fees[Math.min(fees.length - 1, Math.floor(p * fees.length))] ?? 0) : 0));
    const slow = q(0.25);
    const normal = q(0.5) > slow ? q(0.5) : slow + 1000n;
    const fast = q(0.75) * 2n > normal ? q(0.75) * 2n : normal * 2n;
    return {
      options: {
        slow: { level: 'slow', params: { family: 'sol', microLamports: slow }, etaSecs: 20 },
        normal: { level: 'normal', params: { family: 'sol', microLamports: normal }, etaSecs: 8 },
        fast: { level: 'fast', params: { family: 'sol', microLamports: fast }, etaSecs: 2 },
      },
      minimum: { family: 'sol', microLamports: 0n },
      hint: `${normal.toString()} µL/CU`,
      fetchedAt: Date.now(),
    };
  }

  private async compile(instructions: Instruction[], computeUnits: number, microLamports: bigint): Promise<{ message: string; wire: string }> {
    const { value: bh } = await this.rpc<RpcCtx<{ blockhash: string; lastValidBlockHeight: number }>>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(this.me, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.blockhash as Blockhash, lastValidBlockHeight: BigInt(bh.lastValidBlockHeight) }, m),
      (m) => setTransactionMessageComputeUnitLimit(computeUnits, m),
      (m) => (microLamports > 0n ? setTransactionMessageComputeUnitPrice(microLamports, m) : m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const compiled = compileTransaction(msg);
    return { message: getBase64Decoder().decode(compiled.messageBytes), wire: getBase64EncodedWireTransaction(compiled) };
  }

  async buildTx(params: BuildParams): Promise<SolUnsigned> {
    if (params.fee.family !== 'sol') throw new Error('Frais Solana attendus');
    const to = params.to.trim();
    if (!this.isValidAddress(to)) throw new Error('Adresse Solana invalide');
    const recipient = address(to);
    const priority = params.fee.microLamports;
    if (params.asset.kind !== 'native' && params.asset.kind !== 'spl') throw new Error('Actif non pris en charge sur Solana');
    const problem = solanaRecipientProblem(to, await this.accountInfo(recipient));
    if (problem) throw new Error(problem);
    if (params.asset.kind === 'spl') return this.buildSpl(params, recipient, priority);

    const size = { family: 'sol' as const, computeUnits: SOL_TRANSFER_CU, signatures: 1 };
    const maxFee = feeCost(params.fee, size);
    const lamports = params.max ? (await this.lamports()) - maxFee : params.amount;
    if (lamports <= 0n) throw new Error('Solde insuffisant pour couvrir les frais');
    const { message, wire } = await this.compile([systemTransferInstruction(this.me, recipient, lamports)], SOL_TRANSFER_CU, priority);
    return {
      family: 'sol',
      message,
      wire,
      amount: lamports,
      recipient: to,
      maxFee,
      ataRent: 0n,
      createsAta: false,
      summary: `Envoyer ${formatUnits(lamports, 9)} SOL à ${to}`,
      size,
    };
  }

  private async buildSpl(params: BuildParams, recipient: Address, priority: bigint): Promise<SolUnsigned> {
    const mintStr = params.asset.contract;
    if (!mintStr || !isAddress(mintStr)) throw new Error('Mint du token inconnu');
    const mint = address(mintStr);
    if (recipient === this.me) throw new Error('Envoi de token vers ton propre compte : rien à faire.');

    // Mint: program (Token vs Token-2022) from its owner, decimals from its data.
    const [mintAcc, recipientAcc] = await Promise.all([this.accountInfo(mint), this.accountInfo(recipient)]);
    const { tokenProgram, decimals } = parseMintAccount(mintAcc);
    if (decimals !== params.asset.decimals) throw new Error(`Décimales du mint (${decimals}) différentes du registre (${params.asset.decimals}) : envoi bloqué.`);
    if (recipientAcc && (recipientAcc.owner === TOKEN_PROGRAM || recipientAcc.owner === TOKEN_2022_PROGRAM)) {
      throw new Error('Cette adresse est un compte de token, pas un portefeuille : demande l’adresse du portefeuille.');
    }
    const token2022 = tokenProgram === TOKEN_2022_PROGRAM;

    // Source: our token account for this mint (prefer the canonical ATA).
    const ourAta = await findAssociatedTokenAddress(this.me, mint, tokenProgram);
    const { value: accounts } = await this.rpc<RpcCtx<ParsedTokenAccount[]>>('getTokenAccountsByOwner', [this.me, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const owned = accounts.filter((a) => a.account.owner === tokenProgram).map((a) => ({ pubkey: a.pubkey, amount: BigInt(a.account.data.parsed.info.tokenAmount.amount) }));
    const balance = owned.reduce((s, a) => s + a.amount, 0n);
    const amount = params.max ? owned.find((a) => a.pubkey === ourAta)?.amount ?? owned.reduce((m, a) => (a.amount > m ? a.amount : m), 0n) : params.amount;
    if (amount <= 0n) throw new Error('Montant invalide');
    if (amount > balance) throw new Error('Solde de token insuffisant');
    const source = owned.find((a) => a.pubkey === ourAta && a.amount >= amount) ?? owned.filter((a) => a.amount >= amount).sort((a, b) => (b.amount > a.amount ? 1 : -1))[0];
    if (!source) throw new Error('Aucun compte de token ne couvre ce montant (fonds répartis sur plusieurs comptes).');

    // Destination ATA, created if missing.
    const destination = await findAssociatedTokenAddress(recipient, mint, tokenProgram);
    const destAcc = await this.accountInfo(destination);
    if (destAcc && destAcc.owner !== tokenProgram) throw new Error('Le compte de token du destinataire est invalide.');
    const createsAta = destAcc === null;
    const ataRent = createsAta ? BigInt(await this.rpc<number>('getMinimumBalanceForRentExemption', [token2022 ? TOKEN_ACCOUNT_SIZE.token2022 : TOKEN_ACCOUNT_SIZE.token])) : 0n;

    const cu = splComputeUnits(createsAta, token2022);
    const size = { family: 'sol' as const, computeUnits: cu, signatures: 1 };
    const maxFee = feeCost(params.fee, size);
    const lamports = await this.lamports();
    if (lamports < maxFee + ataRent) throw new Error(`SOL insuffisant pour les frais${createsAta ? ' et la création du compte de token du destinataire' : ''}.`);

    const ixs: Instruction[] = [];
    if (createsAta) ixs.push(createAtaIdempotentInstruction({ payer: this.me, ata: destination, owner: recipient, mint, tokenProgram }));
    ixs.push(transferCheckedInstruction({ source: address(source.pubkey), mint, destination, authority: this.me, amount, decimals, tokenProgram }));
    const { message, wire } = await this.compile(ixs, cu, priority);
    return {
      family: 'sol',
      message,
      wire,
      amount,
      recipient: recipient,
      maxFee,
      ataRent,
      createsAta,
      mint,
      destinationTokenAccount: destination,
      tokenProgram: token2022 ? 'token2022' : 'token',
      summary: `Envoyer ${formatUnits(amount, decimals)} ${params.asset.symbol} à ${recipient}`,
      size,
    };
  }

  /** Rust decoding for the "Vérification" panel (before the password). */
  decode(unsigned: SolUnsigned): Promise<SolTxSummary> {
    return call('sol_decode_tx', { message: unsigned.message, ...accountArg(this.account) });
  }

  /** Rust decoding of a third-party wire transaction (a Jupiter swap), before the password. */
  decodeWire(wireB64: string): Promise<SolTxSummary> {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wireB64));
    return call('sol_decode_tx', { message: getBase64Decoder().decode(tx.messageBytes), ...accountArg(this.account) });
  }

  async signTx(unsigned: SolUnsigned, password: string): Promise<SolSigned> {
    const signed = await this.signWireTransaction(unsigned.wire, password);
    const problem = checkSolSummary(unsigned, signed.summary, this.me);
    if (problem) throw new Error(`${problem} Signature écartée.`);
    return signed;
  }

  /** Sign any wire transaction we are a signer of (our builds, Jupiter swaps…). */
  async signWireTransaction(wireB64: string, password: string): Promise<SolSigned & { summary: SolTxSummary }> {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wireB64));
    const message = getBase64Decoder().decode(tx.messageBytes);
    const res = await call('sol_sign_tx', { message, password, ...accountArg(this.account) });
    const index = res.summary.ourSignerIndex;
    if (index === null) throw new Error('Ce compte ne signe pas cette transaction');
    const sig = getBase64Encoder().encode(res.signature) as SignatureBytes;
    const placed = placeSignature(tx, index, sig, this.me);
    return { family: 'sol', wire: getBase64EncodedWireTransaction(placed), signature: getBase58Decoder().decode(sig), summary: res.summary };
  }

  /** Signs on the hardware wallet `deviceId` (same Rust decoding as `sol_sign_tx`). */
  async signTxHw(unsigned: SolUnsigned, deviceId: string): Promise<SolSigned> {
    if (!this.hw) throw new Error('Ce compte n’est pas un hardware wallet');
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(unsigned.wire));
    const message = getBase64Decoder().decode(tx.messageBytes);
    const res = await call('hw_sign_sol_tx', { id: deviceId, accountId: this.hw.accountId, message });
    const index = res.summary.ourSignerIndex;
    if (index === null) throw new Error('Ce compte ne signe pas cette transaction');
    const problem = checkSolSummary(unsigned, res.summary, this.me);
    if (problem) throw new Error(`${problem} Signature écartée.`);
    const sig = getBase64Encoder().encode(res.signature) as SignatureBytes;
    const placed = placeSignature(tx, index, sig, this.me);
    return { family: 'sol', wire: getBase64EncodedWireTransaction(placed), signature: getBase58Decoder().decode(sig) };
  }

  async broadcast(signed: SolSigned): Promise<string> {
    return this.rpc<string>('sendTransaction', [signed.wire, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  }

  async getHistory(): Promise<HistoryItem[]> {
    const sigs = await this.rpc<Array<{ signature: string; blockTime: number | null; err: unknown; confirmationStatus?: string }>>('getSignaturesForAddress', [this.me, { limit: 20 }]);
    const items = await Promise.all(
      sigs.slice(0, 12).map(async (s): Promise<HistoryItem | null> => {
        try {
          const tx = await this.rpc<{
            blockTime: number | null;
            meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[] } | null;
            transaction: { message: { accountKeys: Array<{ pubkey: string }>; instructions?: ParsedIx[] } };
          } | null>('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
          if (!tx?.meta) return null;
          const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
          const i = keys.indexOf(this.me);
          if (i < 0) return null;
          const item = solHistoryItem({
            me: this.me,
            isPayer: i === 0,
            delta: BigInt(tx.meta.postBalances[i] ?? 0) - BigInt(tx.meta.preBalances[i] ?? 0),
            fee: BigInt(tx.meta.fee),
            instructions: tx.transaction.message.instructions ?? [],
          });
          item.id = s.signature;
          item.chainKey = this.chain.key;
          item.status = tx.meta.err || s.err ? 'failed' : s.confirmationStatus === 'finalized' || s.confirmationStatus === 'confirmed' ? 'confirmed' : 'pending';
          const bt = tx.blockTime ?? s.blockTime;
          if (bt) item.time = bt * 1000;
          return item;
        } catch {
          return null;
        }
      }),
    );
    return items.filter((x): x is HistoryItem => x !== null);
  }
}

/** A top-level instruction of a `jsonParsed` transaction (only what the history reads). */
export interface ParsedIx {
  program?: string;
  programId?: string;
  parsed?: { type?: string; info?: { source?: string; destination?: string; lamports?: number | string } } | string;
}

/**
 * One SOL history entry from our balance change and the transaction's decoded instructions.
 *
 * - A change of 0 for an account that did not pay the fees (a 0-lamport transfer involving us,
 *   sent by someone else) is neither received nor sent: a poisoning lure (`suspect: 'zero'`,
 *   shown as a received 0), never an outgoing payment.
 * - The counterparty comes from the decoded System transfers that involve us, never from the
 *   fee payer or « the first other account key » (an attacker who pays the fees would otherwise
 *   be shown as an address we paid). No decoded transfer: no counterparty.
 */
export function solHistoryItem(p: { me: string; isPayer: boolean; delta: bigint; fee: bigint; instructions: ParsedIx[] }): HistoryItem {
  const transfers = p.instructions
    .filter((ix) => ix.program === 'system' || ix.programId === SYSTEM_PROGRAM)
    .map((ix) => (typeof ix.parsed === 'object' && ix.parsed?.type === 'transfer' ? ix.parsed.info : undefined))
    .filter((info): info is NonNullable<typeof info> => !!info && (info.source === p.me || info.destination === p.me));
  let direction: HistoryItem['direction'];
  let amount: bigint;
  if (p.delta > 0n) {
    direction = 'in';
    amount = p.delta;
  } else if (p.isPayer) {
    direction = 'out';
    amount = -p.delta - p.fee > 0n ? -p.delta - p.fee : 0n;
  } else if (p.delta < 0n) {
    direction = 'out';
    amount = -p.delta;
  } else {
    direction = 'in';
    amount = 0n;
  }
  const item: HistoryItem = { id: '', chainKey: '', assetId: 'sol', direction, amount, status: 'confirmed', kind: 'transfer' };
  if (p.isPayer) item.fee = p.fee;
  const t =
    direction === 'in'
      ? (transfers.find((x) => x.destination === p.me && x.source !== p.me) ?? transfers.find((x) => x.source === p.me && x.destination !== p.me))
      : transfers.find((x) => x.source === p.me && x.destination !== p.me);
  const other = t ? (t.source === p.me ? t.destination : t.source) : undefined;
  if (other) item.counterparty = other;
  if (!p.isPayer && p.delta === 0n) item.suspect = 'zero';
  return item;
}
