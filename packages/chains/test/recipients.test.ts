// Recipients that lose the funds are refused before building (EVM and Solana).
import { describe, expect, it } from 'vitest';
import { address } from '@solana/kit';
import { evmRecipientProblem, findAssociatedTokenAddress, solanaRecipientProblem, TOKEN_PROGRAM } from '../src';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

describe('EVM recipients', () => {
  it('refuses the zero address and the token contract itself', () => {
    expect(evmRecipientProblem('0x0000000000000000000000000000000000000000', { kind: 'native' })).toMatch(/Adresse nulle/);
    expect(evmRecipientProblem(USDC.toLowerCase(), { kind: 'erc20', contract: USDC })).toMatch(/contrat du token/);
    expect(evmRecipientProblem(USDC, { kind: 'native' })).toBeNull();
    expect(evmRecipientProblem('0x4F2A9c83b1E07D6a55C0E91B3D7f28aE6c19d7b2', { kind: 'erc20', contract: USDC })).toBeNull();
  });
});

describe('Solana recipients', () => {
  const wallet = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  it('refuses a PDA (off-curve), a program, a token account or a mint', async () => {
    const ata = await findAssociatedTokenAddress(address(wallet), address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), TOKEN_PROGRAM);
    expect(solanaRecipientProblem(ata, null)).toMatch(/PDA/);
    expect(solanaRecipientProblem(wallet, { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true })).toMatch(/programme/);
    expect(solanaRecipientProblem(wallet, { owner: TOKEN_PROGRAM })).toMatch(/compte de token ou un mint/);
    expect(solanaRecipientProblem(wallet, { owner: '11111111111111111111111111111111' })).toBeNull();
    expect(solanaRecipientProblem(wallet, null)).toBeNull();
  });
});
