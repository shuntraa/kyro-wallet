// Solana: instruction byte layouts, ATA derivation, fees, signature placement,
// SPL send end to end against the demo backend.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getBase58Encoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type SignatureBytes,
} from '@solana/kit';
import { base64 } from '@scure/base';
import { call, setBackend, type Accounts, type SolTxSummary } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import {
  ATA_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  checkSolSummary,
  createAdapters,
  createAtaIdempotentInstruction,
  feeCost,
  findAsset,
  findAssociatedTokenAddress,
  parseMintAccount,
  parseUnits,
  placeSignature,
  splComputeUnits,
  systemTransferInstruction,
  transferCheckedInstruction,
  type AdapterSet,
} from '../src';

// Real devnet transaction 5D1jB6tQ…iUhQ (USDC devnet transfer with ATA createIdempotent):
const DEVNET = {
  mint: address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  wallet: address('Cf9abfrZbkkcKthpkKqwmA8H3LiGtGZ2ZL8NsfQzYLQP'),
  ata: address('5iv62nJJJHsV7pgJcA3sf9kp98uWaQcjyKtxFZ5dEbcW'),
  feePayer: address('GxVQ1n7DXnb1iU94CvWuxZQFM56Cj5bk5UpWg7T3Xu2d'),
  authority: address('D7d6ZP2KcmHzhEh4nGrpe7zMKFjXP8wtvceecGB3fKVp'),
  source: address('GXGc5RJU7W4j8FrH38vfGbryht5av3zeiZCmhDN7yRPU'),
  /** base58 instruction data of TransferChecked(amount 1 000 000, decimals 6). */
  transferCheckedData: 'gvPShZQhKrzGM',
  /** base58 instruction data of CreateIdempotent. */
  createIdempotentData: '2',
};

const BLOCKHASH = { blockhash: '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM' as Blockhash, lastValidBlockHeight: 100n };

describe('SPL instruction encoding (against devnet bytes)', () => {
  it('TransferChecked: [12, u64 LE amount, decimals] and account order', () => {
    const ix = transferCheckedInstruction({ source: DEVNET.source, mint: DEVNET.mint, destination: DEVNET.ata, authority: DEVNET.authority, amount: 1_000_000n, decimals: 6, tokenProgram: TOKEN_PROGRAM });
    expect([...(ix.data ?? [])]).toEqual([...getBase58Encoder().encode(DEVNET.transferCheckedData)]);
    expect([...(ix.data ?? [])]).toEqual([12, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0, 6]);
    expect(ix.programAddress).toBe(TOKEN_PROGRAM);
    // devnet accounts [3,7,2,1] = source, mint, destination, authority
    expect(ix.accounts?.map((a) => [a.address, a.role])).toEqual([
      [DEVNET.source, 1],
      [DEVNET.mint, 0],
      [DEVNET.ata, 1],
      [DEVNET.authority, 2],
    ]);
  });

  it('TransferChecked targets Token-2022 when asked and refuses bad decimals', () => {
    expect(transferCheckedInstruction({ source: DEVNET.source, mint: DEVNET.mint, destination: DEVNET.ata, authority: DEVNET.authority, amount: 1n, decimals: 9, tokenProgram: TOKEN_2022_PROGRAM }).programAddress).toBe(TOKEN_2022_PROGRAM);
    expect(() => transferCheckedInstruction({ source: DEVNET.source, mint: DEVNET.mint, destination: DEVNET.ata, authority: DEVNET.authority, amount: 1n, decimals: 256, tokenProgram: TOKEN_PROGRAM })).toThrow();
  });

  it('ATA CreateIdempotent: data [1], accounts payer/ata/owner/mint/system/token', () => {
    const ix = createAtaIdempotentInstruction({ payer: DEVNET.feePayer, ata: DEVNET.ata, owner: DEVNET.wallet, mint: DEVNET.mint, tokenProgram: TOKEN_PROGRAM });
    expect([...(ix.data ?? [])]).toEqual([...getBase58Encoder().encode(DEVNET.createIdempotentData)]);
    expect(ix.programAddress).toBe(ATA_PROGRAM);
    // devnet accounts [0,2,9,7,4,6] (+ legacy rent sysvar, optional)
    expect(ix.accounts?.map((a) => [a.address, a.role])).toEqual([
      [DEVNET.feePayer, 3],
      [DEVNET.ata, 1],
      [DEVNET.wallet, 0],
      [DEVNET.mint, 0],
      [SYSTEM_PROGRAM, 0],
      [TOKEN_PROGRAM, 0],
    ]);
  });

  it('System transfer: [2,0,0,0, u64 LE lamports]', () => {
    const ix = systemTransferInstruction(DEVNET.feePayer, DEVNET.wallet, 5_000_000_000n);
    expect([...(ix.data ?? [])]).toEqual([2, 0, 0, 0, 0x00, 0xf2, 0x05, 0x2a, 0x01, 0, 0, 0]);
  });
});

describe('ATA derivation', () => {
  it('matches the account created on devnet', async () => {
    expect(await findAssociatedTokenAddress(DEVNET.wallet, DEVNET.mint, TOKEN_PROGRAM)).toBe(DEVNET.ata);
  });
  it('depends on the token program (Token-2022 gives another address)', async () => {
    expect(await findAssociatedTokenAddress(DEVNET.wallet, DEVNET.mint, TOKEN_2022_PROGRAM)).not.toBe(DEVNET.ata);
  });
});

describe('mint parsing', () => {
  const mintData = (decimals: number, init = 1) => {
    const b = new Uint8Array(82);
    b[44] = decimals;
    b[45] = init;
    return [base64.encode(b), 'base64'] as [string, string];
  };
  it('reads decimals and program from the owner', () => {
    expect(parseMintAccount({ owner: TOKEN_PROGRAM, lamports: 1, data: mintData(6) })).toEqual({ tokenProgram: TOKEN_PROGRAM, decimals: 6 });
    expect(parseMintAccount({ owner: TOKEN_2022_PROGRAM, lamports: 1, data: mintData(9) }).tokenProgram).toBe(TOKEN_2022_PROGRAM);
  });
  it('rejects non-mints', () => {
    expect(() => parseMintAccount(null)).toThrow(/introuvable/);
    expect(() => parseMintAccount({ owner: SYSTEM_PROGRAM, lamports: 1, data: mintData(6) })).toThrow();
    expect(() => parseMintAccount({ owner: TOKEN_PROGRAM, lamports: 1, data: mintData(6, 0) })).toThrow(/initialisé/);
  });
});

describe('Solana fee math', () => {
  it('compute budget for SPL sends', () => {
    expect(splComputeUnits(false, false)).toBe(10_000);
    expect(splComputeUnits(true, false)).toBe(40_000);
    expect(splComputeUnits(true, true)).toBe(80_000);
  });
  it('custom priority fee: base + ceil(µL × CU / 1e6)', () => {
    const size = { family: 'sol' as const, computeUnits: splComputeUnits(true, false), signatures: 1 };
    expect(feeCost({ family: 'sol', microLamports: 25_000n }, size)).toBe(5000n + 1000n);
    expect(feeCost({ family: 'sol', microLamports: 1n }, size)).toBe(5001n); // rounds up
    expect(feeCost({ family: 'sol', microLamports: 0n }, { ...size, signatures: 2 })).toBe(10_000n);
  });
});

describe('signature placement', () => {
  // Fee payer ≠ us: our signature belongs in slot 1 (like the devnet tx above).
  const tx = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(DEVNET.feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(BLOCKHASH, m),
      (m) => appendTransactionMessageInstruction(transferCheckedInstruction({ source: DEVNET.source, mint: DEVNET.mint, destination: DEVNET.ata, authority: DEVNET.authority, amount: 1n, decimals: 6, tokenProgram: TOKEN_PROGRAM }), m),
    ),
  );
  const sig = new Uint8Array(64).fill(7) as SignatureBytes;

  it('puts the signature at index 1 and leaves slot 0 empty', () => {
    expect(Object.keys(tx.signatures)).toEqual([DEVNET.feePayer, DEVNET.authority]);
    const placed = placeSignature(tx, 1, sig, DEVNET.authority);
    expect(placed.signatures[DEVNET.authority]).toEqual(sig);
    expect(placed.signatures[DEVNET.feePayer]).toBeNull();
    const wire = getBase64Encoder().encode(getBase64EncodedWireTransaction(placed));
    expect(wire[0]).toBe(2); // two signature slots
    expect([...wire.slice(1, 65)].every((b) => b === 0)).toBe(true);
    expect([...wire.slice(65, 129)].every((b) => b === 7)).toBe(true);
  });

  it('refuses a slot that is not ours or out of range', () => {
    expect(() => placeSignature(tx, 0, sig, DEVNET.authority)).toThrow(/notre adresse/);
    expect(() => placeSignature(tx, 2, sig, DEVNET.authority)).toThrow(/hors limites/);
    expect(() => placeSignature(tx, 1, new Uint8Array(10) as SignatureBytes, DEVNET.authority)).toThrow();
  });
});

describe('SolanaAdapter against the demo backend', () => {
  const PASSWORD = 'correct horse battery';
  let accounts: Accounts;
  let adapters: AdapterSet;
  const confirms: string[] = [];

  beforeAll(async () => {
    const mock = createMockBackend({ network: 'testnet', confirm: (m) => (confirms.push(m), true), preset: { password: PASSWORD, unlocked: true } });
    setBackend(mock.invoke);
    accounts = await call('accounts_get');
    adapters = createAdapters(accounts);
  });

  it('SPL send: on-chain decimals, ATA creation, Rust summary matches, signed and broadcast', async () => {
    const usdc = findAsset('testnet', 'spl:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    if (!usdc) throw new Error('asset');
    expect(usdc.readOnly).toBeUndefined();
    const to = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
    const unsigned = await adapters.sol!.buildTx({ asset: usdc, to, amount: parseUnits('12,5', 6), fee: { family: 'sol', microLamports: 50_000n } });
    expect(unsigned.createsAta).toBe(true);
    expect(unsigned.ataRent).toBe(2_039_280n);
    expect(unsigned.tokenProgram).toBe('token');
    expect(unsigned.destinationTokenAccount).toBe(await findAssociatedTokenAddress(address(to), address(usdc.contract ?? ''), TOKEN_PROGRAM));
    expect(unsigned.maxFee).toBe(5000n + 2000n);

    const summary = await adapters.sol!.decode(unsigned);
    expect(summary.ourSignerIndex).toBe(0);
    expect(summary.requiresExtraConfirmation).toBe(false);
    expect(summary.priorityFeeLamports).toBe('2000');
    expect(summary.instructions.map((i) => i.type)).toEqual(['computeUnitLimit', 'computeUnitPrice', 'ataCreate', 'tokenTransfer']);
    expect(checkSolSummary(unsigned, summary, accounts.sol.address)).toBeNull();

    const signed = await adapters.sol!.signTx(unsigned, PASSWORD);
    expect(await adapters.sol!.broadcast(signed)).toBe(signed.signature);
  });

  it('detects a summary that differs from what was built', async () => {
    const usdc = findAsset('testnet', 'spl:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')!;
    const unsigned = await adapters.sol!.buildTx({ asset: usdc, to: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', amount: 1_000_000n, fee: { family: 'sol', microLamports: 0n } });
    const s = await adapters.sol!.decode(unsigned);
    const tampered: SolTxSummary = { ...s, instructions: s.instructions.map((i) => (i.type === 'tokenTransfer' ? { ...i, amount: '999999999' } : i)) };
    expect(checkSolSummary(unsigned, tampered, accounts.sol.address)).toMatch(/différent/);
    expect(checkSolSummary(unsigned, { ...s, feePayer: DEVNET.feePayer }, accounts.sol.address)).toMatch(/payeur/);
  });

  it('refuses decimals that disagree with the mint', async () => {
    const usdc = findAsset('testnet', 'spl:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')!;
    await expect(adapters.sol!.buildTx({ asset: { ...usdc, decimals: 9 }, to: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', amount: 1n, fee: { family: 'sol', microLamports: 0n } })).rejects.toThrow(/Décimales/);
  });

  it('signs a foreign transaction at our index (1) with a second confirmation', async () => {
    const me = address(accounts.sol.address);
    const tx = compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(DEVNET.feePayer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(BLOCKHASH, m),
        (m) => appendTransactionMessageInstruction(systemTransferInstruction(me, DEVNET.wallet, 1n), m),
      ),
    );
    confirms.length = 0;
    const signed = await adapters.sol!.signWireTransaction(getBase64EncodedWireTransaction(tx), PASSWORD);
    expect(signed.summary.ourSignerIndex).toBe(1);
    expect(signed.summary.requiresExtraConfirmation).toBe(true);
    expect(confirms).toHaveLength(2);
    const back = getTransactionDecoder().decode(getBase64Encoder().encode(signed.wire));
    expect(Object.keys(back.signatures)).toEqual([DEVNET.feePayer, me]);
    expect(back.signatures[me]).not.toBeNull();
    expect(back.signatures[DEVNET.feePayer] === null || [...(back.signatures[DEVNET.feePayer] ?? [])].every((b) => b === 0)).toBe(true);
  });
});
