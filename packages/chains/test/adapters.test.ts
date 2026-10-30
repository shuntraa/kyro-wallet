// End-to-end adapter flows against the demo backend (fake vault + fake chains).
import { beforeAll, describe, expect, it } from 'vitest';
import { call, setBackend, type Accounts } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { assetsFor, createAdapters, findAsset, parseUnits, type AdapterSet } from '../src';

let accounts: Accounts;
let adapters: AdapterSet;
const PASSWORD = 'correct horse battery';

beforeAll(async () => {
  const mock = createMockBackend({ network: 'testnet', confirm: () => true, preset: { password: PASSWORD, unlocked: true } });
  setBackend(mock.invoke);
  accounts = await call('accounts_get');
  adapters = createAdapters(accounts);
});

describe('BitcoinAdapter', () => {
  it('derives the same first addresses as the vault from the xpubs', () => {
    expect(adapters.btc.addressAt('segwit', 0, 0).address).toBe(accounts.btc.segwit.address);
    expect(adapters.btc.addressAt('taproot', 0, 0).address).toBe(accounts.btc.taproot.address);
  });

  it('scans balances across SegWit + Taproot', async () => {
    const [b] = await adapters.btc.getBalance();
    expect(b).toEqual({ assetId: 'btc', amount: 4_120_000n + 890_000n + 210_000n + 350_000n });
  });

  it('builds a PSBT with derivation info, signs via IPC and extracts a tx', async () => {
    const asset = findAsset('testnet', 'btc');
    if (!asset) throw new Error('asset');
    const unsigned = await adapters.btc.buildTx({ asset, to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', amount: 1_000_000n, fee: { family: 'btc', satPerVb: 5 } });
    expect(unsigned.summary.outputs[0]).toEqual(['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 1_000_000, false]);
    expect(unsigned.summary.outputs[1]?.[2]).toBe(true);
    expect(unsigned.fee).toBeGreaterThan(0n);
    const signed = await adapters.btc.signTx(unsigned, PASSWORD);
    expect(signed.hex).toMatch(/^02000000/);
    expect(await adapters.btc.broadcast(signed)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects addresses of the wrong network', () => {
    expect(adapters.btc.isValidAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(false);
    expect(adapters.btc.isValidAddress(accounts.btc.taproot.address)).toBe(true);
  });

  it('lists incoming history', async () => {
    const h = await adapters.btc.getHistory();
    expect(h.length).toBeGreaterThan(0);
    expect(h.every((x) => x.direction === 'in')).toBe(true);
  });
});

describe('EvmAdapter (Sepolia, viem custom transport → net_fetch)', () => {
  it('reads native + ERC-20 balances', async () => {
    const evm = adapters.evm.get('sepolia');
    const bal = await evm!.getBalance();
    expect(bal.find((b) => b.assetId === 'eth:11155111')?.amount).toBe(842_100_000_000_000_000n);
    expect(bal.find((b) => b.assetId.startsWith('erc20:11155111:0x1c7d'))?.amount).toBe(250_500_000n);
  });

  it('builds an ERC-20 transfer with token hint, decodes it in "Rust" and broadcasts', async () => {
    const evm = adapters.evm.get('sepolia')!;
    const usdc = assetsFor('testnet').find((a) => a.kind === 'erc20')!;
    const fees = await evm.estimateFees();
    const unsigned = await evm.buildTx({ asset: usdc, to: '0x000000000000000000000000000000000000dEaD', amount: parseUnits('12,5', 6), fee: fees.options.normal.params });
    expect(unsigned.token).toEqual({ symbol: 'USDC', decimals: 6 });
    expect(unsigned.tx.chainId).toBe(11155111);
    expect(unsigned.tx.gasLimit).toBeGreaterThan(21_000);
    const summary = await evm.decode(unsigned);
    expect(summary).toMatchObject({ kind: 'Erc20Transfer', amount: '12500000', unlimitedApproval: false });
    const signed = await evm.signTx(unsigned, PASSWORD);
    expect(await evm.broadcast(signed)).toBe(signed.hash);
    expect(await evm.waitForReceipt(signed.hash, 1000, 10)).toBe(true);
  });

  it('estimates EIP-1559 fees in increasing order', async () => {
    const f = await adapters.evm.get('sepolia')!.estimateFees();
    const m = (l: 'slow' | 'normal' | 'fast') => (f.options[l].params as { maxFeePerGas: bigint }).maxFeePerGas;
    expect(m('slow') <= m('normal') && m('normal') <= m('fast')).toBe(true);
  });
});

describe('SolanaAdapter', () => {
  it('reads SOL + SPL balances', async () => {
    const bal = await adapters.sol.getBalance();
    expect(bal[0]).toEqual({ assetId: 'sol', amount: 3_200_000_000n });
    expect(bal.find((b) => b.assetId.startsWith('spl:'))?.amount).toBe(42_000_000n);
  });

  it('builds, signs (message bytes via IPC) and broadcasts a SOL transfer', async () => {
    const sol = findAsset('testnet', 'sol')!;
    const unsigned = await adapters.sol.buildTx({ asset: sol, to: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', amount: parseUnits('0,5', 9), fee: { family: 'sol', microLamports: 1000n } });
    expect(unsigned.maxFee).toBe(5001n);
    const signed = await adapters.sol.signTx(unsigned, PASSWORD);
    expect(await adapters.sol.broadcast(signed)).toBe(signed.signature);
  });
});
