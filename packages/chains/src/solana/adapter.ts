// SPDX-License-Identifier: GPL-3.0-or-later
//
// Solana adapter. Messages are built with @solana/kit; the compiled message
// bytes are signed in Rust (`sol_sign_message`), then assembled into a wire
// transaction here. SPL balances are read-only for now.

import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  isAddress,
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
import { call, jsonRpc, netFetch, type NetFetch } from '@kyro/shared';
import { SPL_TOKENS, type SolChain } from '../registry';
import { feeCost } from '../fees';
import { formatUnits } from '../units';
import type { Balance, BuildParams, ChainAdapter, FeeEstimates, HistoryItem, SolSigned, SolUnsigned } from '../types';

const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** System transfer (~150 CU) + 2 compute-budget instructions (~150 CU each), with margin. */
export const SOL_TRANSFER_CU = 600;

export interface SolanaAdapterOptions {
  chain: SolChain;
  address: string;
  rpcUrl?: string;
  fetch?: NetFetch;
}

interface RpcCtx<T> {
  context: { slot: number };
  value: T;
}

/** SystemProgram::Transfer instruction (index 2, u64 LE lamports). */
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

export class SolanaAdapter implements ChainAdapter<'sol'> {
  readonly family = 'sol' as const;
  readonly chain: SolChain;
  readonly rpcUrl: string;
  latencyMs: number | null = null;
  private readonly me: Address;
  private readonly fetcher: NetFetch;

  constructor(opts: SolanaAdapterOptions) {
    if (!isAddress(opts.address)) throw new Error('Adresse Solana du coffre invalide');
    this.chain = opts.chain;
    this.me = address(opts.address);
    this.fetcher = opts.fetch ?? netFetch;
    this.rpcUrl = opts.rpcUrl || opts.chain.rpcUrl;
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

  async getBalance(): Promise<Balance[]> {
    const [bal, tokens] = await Promise.all([
      this.rpc<RpcCtx<number>>('getBalance', [this.me, { commitment: 'confirmed' }]),
      this.rpc<RpcCtx<Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } } }>>>('getTokenAccountsByOwner', [
        this.me,
        { programId: TOKEN_PROGRAM },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ]).catch(() => null),
    ]);
    const out: Balance[] = [{ assetId: 'sol', amount: BigInt(bal.value) }];
    const known = SPL_TOKENS[this.chain.network];
    for (const t of known) {
      const amount = (tokens?.value ?? [])
        .filter((a) => a.account.data.parsed.info.mint === t.contract)
        .reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
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

  async buildTx(params: BuildParams): Promise<SolUnsigned> {
    if (params.fee.family !== 'sol') throw new Error('Frais Solana attendus');
    if (params.asset.kind !== 'native') throw new Error('Les envois de tokens SPL arrivent bientôt (lecture seule pour l’instant)');
    const to = params.to.trim();
    if (!this.isValidAddress(to)) throw new Error('Adresse Solana invalide');
    const size = { family: 'sol' as const, computeUnits: SOL_TRANSFER_CU, signatures: 1 };
    const maxFee = feeCost(params.fee, size);
    let lamports = params.amount;
    if (params.max) {
      const bal = await this.rpc<RpcCtx<number>>('getBalance', [this.me, { commitment: 'confirmed' }]);
      lamports = BigInt(bal.value) - maxFee;
    }
    if (lamports <= 0n) throw new Error('Solde insuffisant pour couvrir les frais');
    const { value: bh } = await this.rpc<RpcCtx<{ blockhash: string; lastValidBlockHeight: number }>>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const priority = params.fee.microLamports;
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(this.me, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.blockhash as Blockhash, lastValidBlockHeight: BigInt(bh.lastValidBlockHeight) }, m),
      (m) => setTransactionMessageComputeUnitLimit(SOL_TRANSFER_CU, m),
      (m) => (priority > 0n ? setTransactionMessageComputeUnitPrice(priority, m) : m),
      (m) => appendTransactionMessageInstruction(systemTransferInstruction(this.me, address(to), lamports), m),
    );
    const compiled = compileTransaction(msg);
    const message = getBase64Decoder().decode(compiled.messageBytes);
    return {
      family: 'sol',
      message,
      amount: lamports,
      recipient: to,
      maxFee,
      summary: `Envoyer ${formatUnits(lamports, 9)} SOL à ${to} · frais max. ${formatUnits(maxFee, 9)} SOL`,
      size,
    };
  }

  private async signMessageBytes(messageB64: string, password: string, summary: string): Promise<SignatureBytes> {
    const res = await call('sol_sign_message', { message: messageB64, password, summary });
    const sig = getBase64Encoder().encode(res.signature);
    if (sig.length !== 64) throw new Error('Signature Solana invalide');
    return sig as SignatureBytes;
  }

  private assemble(tx: Transaction, sig: SignatureBytes): SolSigned {
    if (!(this.me in tx.signatures)) throw new Error('La transaction ne demande pas la signature de ce compte');
    const signed: Transaction = { ...tx, signatures: { ...tx.signatures, [this.me]: sig } };
    return { family: 'sol', wire: getBase64EncodedWireTransaction(signed), signature: getBase58Decoder().decode(sig) };
  }

  async signTx(unsigned: SolUnsigned, password: string): Promise<SolSigned> {
    const sig = await this.signMessageBytes(unsigned.message, password, unsigned.summary);
    const messageBytes = getBase64Encoder().encode(unsigned.message);
    // Re-wrap the exact bytes that were signed; only our signature slot exists.
    const tx = { messageBytes, signatures: { [this.me]: null } } as unknown as Transaction;
    return this.assemble(tx, sig);
  }

  /** Sign a ready-made wire transaction (e.g. Jupiter swap). */
  async signWireTransaction(wireB64: string, password: string, summary: string): Promise<SolSigned> {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wireB64));
    const sig = await this.signMessageBytes(getBase64Decoder().decode(tx.messageBytes), password, summary);
    return this.assemble(tx, sig);
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
            transaction: { message: { accountKeys: Array<{ pubkey: string }> } };
          } | null>('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
          if (!tx?.meta) return null;
          const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
          const i = keys.indexOf(this.me);
          if (i < 0) return null;
          const delta = BigInt(tx.meta.postBalances[i] ?? 0) - BigInt(tx.meta.preBalances[i] ?? 0);
          const isPayer = i === 0;
          const fee = BigInt(tx.meta.fee);
          const direction = delta > 0n ? 'in' : 'out';
          const other = keys.find((k, j) => j !== i && k !== SYSTEM_PROGRAM && !k.startsWith('ComputeBudget'));
          const item: HistoryItem = {
            id: s.signature,
            chainKey: this.chain.key,
            assetId: 'sol',
            direction,
            amount: direction === 'in' ? delta : -delta - (isPayer ? fee : 0n),
            status: tx.meta.err || s.err ? 'failed' : s.confirmationStatus === 'finalized' || s.confirmationStatus === 'confirmed' ? 'confirmed' : 'pending',
            kind: 'transfer',
          };
          if (isPayer) item.fee = fee;
          if (other) item.counterparty = other;
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
