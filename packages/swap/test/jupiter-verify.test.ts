// Jupiter's third-party transaction: checked against the reviewed swap before the password.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getBase64Decoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { sha256, stringToBytes } from 'viem';
import { setBackend, type SolInstruction, type SolTxSummary } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { demoAta } from '../../shared/src/mock-jupiter';
import { createProviders, JUPITER_MAX_PRIORITY_LAMPORTS, verifyJupiterSwap, type JupiterCheckInput } from '../src';
import { associatedTokenAccount } from '../src/providers/jupiter';

interface Case { name: string; wire: string; sellMint: string; buyMint: string; sellAmount: string; slippageBps: number; quotedOut: string; accountKeys: string[] }
const fx = JSON.parse(readFileSync(new URL('./fixtures/jupiter-swaps.json', import.meta.url), 'utf8')) as { taker: string; feeAccount: string; cases: Case[] };
const THIEF = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

const le = (b: Uint8Array, at: number, n: number) => {
  let v = 0n;
  for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[at + i] ?? 0);
  return v;
};

/** The same summary as wallet-core's decoder would give (accounts resolved with the lookup tables). */
function summaryOf(wire: string, keys: string[], me: string): SolTxSummary {
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

const input = (c: Case, over: Partial<JupiterCheckInput> = {}): JupiterCheckInput => ({
  wire: c.wire,
  summary: summaryOf(c.wire, c.accountKeys, fx.taker),
  taker: fx.taker,
  sellMint: c.sellMint,
  buyMint: c.buyMint,
  sellAmount: BigInt(c.sellAmount),
  slippageBps: c.slippageBps,
  quotedOut: BigInt(c.quotedOut),
  fee: { bps: 70, account: fx.feeAccount },
  ...over,
});

const routeIndex = (s: SolTxSummary) => s.instructions.findIndex((x) => x.type === 'unknown' && x.programId.startsWith('JUP6'));
const withRouteKey = (s: SolTxSummary, at: number, key: string): SolTxSummary => ({
  ...s,
  instructions: s.instructions.map((x, i) => (i === routeIndex(s) && x.type === 'unknown' ? { ...x, accountKeys: x.accountKeys.map((k, j) => (j === at ? key : k)) } : x)),
});

describe('Jupiter: demo mode transaction (mock-jupiter.ts) passes the same check', () => {
  it('ATA derivation of the demo matches @solana/kit', async () => {
    for (const owner of [fx.taker, 'ptsbLdrhmEfC2eQ9gj4aieF4irdhQqYzK1fdNwHBZcM']) {
      for (const mint of ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'So11111111111111111111111111111111111111112']) expect(demoAta(owner, mint)).toBe(await associatedTokenAccount(owner, mint));
    }
  });

  it('quote → build → Rust-like decoding (demo) → verified, both directions', async () => {
    const backend = createMockBackend({ network: 'mainnet', torEnabled: false, preset: { password: 'correct horse', unlocked: true } });
    setBackend(backend.invoke);
    const taker = backend.chain.accounts.sol.address;
    const [, , jup] = createProviders({ hasZeroxKey: () => true });
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const WSOL = 'So11111111111111111111111111111111111111112';
    for (const [sellMint, buyMint, amount] of [[USDC, WSOL, 10_000_000n], [WSOL, USDC, 100_000_000n]] as const) {
      const q = await jup!.quote({ chain: 'solana', sell: { address: sellMint, symbol: 'A', decimals: 6 }, buy: { address: buyMint, symbol: 'B', decimals: 9 }, sellAmount: amount, taker, slippageBps: 50 });
      if (q.tx.kind !== 'solana') throw new Error('solana attendu');
      const wire = await q.tx.build();
      const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
      const summary = (await backend.invoke('sol_decode_tx', { message: getBase64Decoder().decode(tx.messageBytes) })) as SolTxSummary;
      const r = await verifyJupiterSwap({ wire, summary, taker, sellMint, buyMint, sellAmount: amount, slippageBps: 50, quotedOut: q.buyAmount, fee: { bps: 70, account: q.solFeeAccount! } });
      expect(r.platformFeeBps).toBe(70);
    }
  });
});

describe('Jupiter: route discriminators are Anchor’s sha256("global:<name>")[0..8]', () => {
  it('route and shared_accounts_route', () => {
    expect(sha256(stringToBytes('global:route')).slice(0, 18)).toBe('0xe517cb977ae3ad2a');
    expect(sha256(stringToBytes('global:shared_accounts_route')).slice(0, 18)).toBe('0xc1209b3341d69c81');
  });
});

describe('Jupiter: real transactions (lite-api.jup.ag, 01/11/2026)', () => {
  for (const c of fx.cases) {
    it(`${c.name}: accepted as built`, async () => {
      const r = await verifyJupiterSwap(input(c));
      expect(r).toMatchObject({ route: 'route', inAmount: BigInt(c.sellAmount), slippageBps: 50, platformFeeBps: 70 });
      expect(r.quotedOut).toBe(BigInt(c.quotedOut));
    });

    it(`${c.name}: refused when anything differs from the reviewed swap`, async () => {
      const base = input(c);
      await expect(verifyJupiterSwap({ ...base, taker: THIEF })).rejects.toThrow(/payeur/);
      await expect(verifyJupiterSwap({ ...base, sellAmount: base.sellAmount + 1n })).rejects.toThrow(/montant vendu/);
      await expect(verifyJupiterSwap({ ...base, slippageBps: 100 })).rejects.toThrow(/slippage/);
      await expect(verifyJupiterSwap({ ...base, quotedOut: base.quotedOut + 1n })).rejects.toThrow(/plus bas que le devis/);
      await expect(verifyJupiterSwap({ ...base, fee: null })).rejects.toThrow(/frais de plateforme/);
      await expect(verifyJupiterSwap({ ...base, fee: { bps: 70, account: THIEF } })).rejects.toThrow(/autre compte/);
      await expect(verifyJupiterSwap({ ...base, sellMint: c.buyMint, buyMint: c.sellMint })).rejects.toThrow();
      // The same bytes, but Rust resolved other accounts (another destination, another fee account, another authority).
      await expect(verifyJupiterSwap({ ...base, summary: withRouteKey(base.summary, 3, THIEF) })).rejects.toThrow(/compte crédité/);
      await expect(verifyJupiterSwap({ ...base, summary: withRouteKey(base.summary, 6, THIEF) })).rejects.toThrow(/autre compte/);
      await expect(verifyJupiterSwap({ ...base, summary: withRouteKey(base.summary, 1, THIEF) })).rejects.toThrow(/autorité/);
      // CloseAccount that would send the wrapped SOL elsewhere.
      const close = base.summary.instructions.findIndex((x) => x.type === 'unknown' && x.programId.startsWith('Tokenkeg') && x.accounts === 3);
      const stolen = { ...base.summary, instructions: base.summary.instructions.map((x, i) => (i === close && x.type === 'unknown' ? { ...x, accountKeys: [x.accountKeys[0] ?? '', THIEF, fx.taker] } : x)) };
      await expect(verifyJupiterSwap({ ...base, summary: stolen })).rejects.toThrow(/Token non autorisée/);
      // A token transfer or an approval slipped in place of an instruction: never allowed.
      const transfer: SolInstruction = { type: 'tokenTransfer', tokenProgram: 'token', checked: false, source: 'x', destination: THIEF, authority: fx.taker, mint: null, amount: '1', decimals: null, multisigSigners: [] };
      await expect(verifyJupiterSwap({ ...base, summary: { ...base.summary, instructions: base.summary.instructions.map((x, i) => (i === close ? transfer : x)) } })).rejects.toThrow(/non autorisé dans un swap/);
      await expect(verifyJupiterSwap({ ...base, summary: { ...base.summary, warnings: [...base.summary.warnings, { kind: 'delegation', instruction: 0 }] } })).rejects.toThrow(/delegation/);
      await expect(verifyJupiterSwap({ ...base, summary: { ...base.summary, priorityFeeLamports: String(JUPITER_MAX_PRIORITY_LAMPORTS + 1n) } })).rejects.toThrow(/priorité/);
      await expect(verifyJupiterSwap({ ...base, summary: { ...base.summary, instructions: base.summary.instructions.slice(1) } })).rejects.toThrow(/ne correspond pas/);
    });
  }

  it('sol-usdc: the SOL wrap must go to our own wSOL account', async () => {
    const c = fx.cases.find((x) => x.name === 'sol-usdc')!;
    const base = input(c);
    const wrap = base.summary.instructions.findIndex((x) => x.type === 'systemTransfer');
    expect(wrap).toBeGreaterThanOrEqual(0);
    const away = { ...base.summary, instructions: base.summary.instructions.map((x, i) => (i === wrap && x.type === 'systemTransfer' ? { ...x, to: THIEF } : x)) };
    await expect(verifyJupiterSwap({ ...base, summary: away })).rejects.toThrow(/transfert de SOL/);
  });
});
