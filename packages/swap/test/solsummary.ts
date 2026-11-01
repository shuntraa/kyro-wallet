// Test helper: the summary wallet-core's `sol_decode_tx` gives for a wire transaction (accounts
// resolved: `keys` = static keys + lookup-table keys; static keys alone without tables).
import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import type { SolInstruction, SolTxSummary } from '@kyro/shared';

const le = (b: Uint8Array, at: number, n: number) => {
  let v = 0n;
  for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[at + i] ?? 0);
  return v;
};

export function staticKeys(wire: string): string[] {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  return getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts.map(String);
}

export function summaryOf(wire: string, keys: string[], me: string): SolTxSummary {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (!('instructions' in m)) throw new Error('v1');
  let limit: number | null = null;
  let price: bigint | null = null;
  const instructions = m.instructions.map((x): SolInstruction => {
    const program = keys[x.programAddressIndex] ?? '';
    const acc = (x.accountIndices ?? []).map((i) => keys[i] ?? '');
    const d = new Uint8Array(x.data ?? []);
    if (program === 'ComputeBudget111111111111111111111111111111' && d[0] === 2) return { type: 'computeUnitLimit', units: (limit = Number(le(d, 1, 4))) };
    if (program === 'ComputeBudget111111111111111111111111111111' && d[0] === 3) return { type: 'computeUnitPrice', microLamports: String((price = le(d, 1, 8))) };
    if (program === '11111111111111111111111111111111' && le(d, 0, 4) === 2n) return { type: 'systemTransfer', from: acc[0] ?? '', to: acc[1] ?? '', lamports: le(d, 4, 8).toString() };
    if (program === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL') return { type: 'ataCreate', idempotent: d[0] === 1, payer: acc[0] ?? '', account: acc[1] ?? '', owner: acc[2] ?? '', mint: acc[3] ?? '', tokenProgram: acc[5] ?? null };
    if ((program === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' || program === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') && d[0] === 12 && d.length === 10) {
      return { type: 'tokenTransfer', tokenProgram: program === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ? 'token' : 'token2022', checked: true, source: acc[0] ?? '', mint: acc[1] ?? '', destination: acc[2] ?? '', authority: acc[3] ?? '', amount: le(d, 1, 8).toString(), decimals: d[9] ?? 0, multisigSigners: acc.slice(4) };
    }
    return { type: 'unknown', programId: program, accounts: acc.length, accountKeys: acc, dataLen: d.length };
  });
  const signers = keys.slice(0, m.header.numSignerAccounts);
  return {
    version: 'v0',
    feePayer: keys[0] ?? '',
    signers,
    ourSignerIndex: signers.indexOf(me) >= 0 ? signers.indexOf(me) : null,
    recentBlockhash: '',
    instructions,
    lookupTables: [],
    baseFeeLamports: '5000',
    computeUnitLimit: limit,
    computeUnitPriceMicroLamports: price === null ? null : String(price),
    priorityFeeLamports: price === null ? null : String((price * BigInt(limit ?? 200_000) + 999_999n) / 1_000_000n),
    warnings: instructions.flatMap((x, i) => (x.type === 'unknown' ? [{ kind: 'unknownInstruction' as const, instruction: i, programId: x.programId }] : [])),
    requiresExtraConfirmation: true,
  };
}
