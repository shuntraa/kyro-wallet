// Reinforced-confirmation triggers of the Bitcoin and EVM summaries (docs/IPC.md §1).
import { describe, expect, it } from 'vitest';
import { btcWarnings, call, evmHighFeeThresholdWei, evmWarnings, setBackend, type EvmTxRequest } from '../src';
import { createMockBackend } from '../src/mock';

const OUT = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

describe('Bitcoin warnings', () => {
  it('plain payment: none', () => {
    expect(btcWarnings({ outputs: [[OUT, 100_000, false], [OUT, 50_000, true]], feeSats: 1_410, vsize: 141 })).toEqual({ warnings: [], requiresExtraConfirmation: false });
  });
  it('unknown script, OP_RETURN, foreign input, fee > 100 sat/vB, fee > outputs', () => {
    const r = btcWarnings({ outputs: [['op_return:6a0568656c6c6f', 0, false], ['script:51', 1_000, false]], feeSats: 1_000, vsize: 200, foreignInputs: [1] });
    expect(r.warnings).toEqual([
      { kind: 'foreignInput', input: 1 },
      { kind: 'opReturn', output: 0 },
      { kind: 'unknownScript', output: 1 },
    ]);
    expect(btcWarnings({ outputs: [[OUT, 100_000, false]], feeSats: 14_241, vsize: 141 }).warnings).toEqual([{ kind: 'highFee', satPerVb: 101 }]);
    // Exactly 100 sat/vB is not above the threshold.
    expect(btcWarnings({ outputs: [[OUT, 100_000, false]], feeSats: 14_100, vsize: 141 }).requiresExtraConfirmation).toBe(false);
    expect(btcWarnings({ outputs: [[OUT, 500, false]], feeSats: 600, vsize: 141 }).warnings).toEqual([{ kind: 'highFee', satPerVb: 4 }]);
  });
});

describe('EVM warnings', () => {
  const base = { spender: null, amount: '0', unlimitedApproval: false, chainId: 11_155_111, maxFeeWei: '1000000000000000' };
  it('transfers: none; any other call, every approval, value + calldata, unknown chain, high fee', () => {
    expect(evmWarnings({ ...base, kind: 'NativeTransfer' }, { data: '0x', valueWei: '1' }).warnings).toEqual([]);
    expect(evmWarnings({ ...base, kind: 'Erc20Transfer' }, { data: '0xa9059cbb00', valueWei: '0' }).warnings).toEqual([]);
    expect(evmWarnings({ ...base, kind: 'ContractCall' }, { data: '0x12345678', valueWei: '5' }).warnings).toEqual([{ kind: 'contractCall' }, { kind: 'valueToContract', valueWei: '5' }]);
    const exact = evmWarnings({ ...base, kind: 'Erc20Approve', spender: '0xS', amount: '1000000' }, { data: '0x095ea7b3', valueWei: '0' });
    expect(exact.warnings).toEqual([{ kind: 'approval', spender: '0xS', amount: '1000000', unlimited: false }]);
    const big = (1n << 128n).toString();
    expect(evmWarnings({ ...base, kind: 'Erc20Approve', spender: '0xS', amount: big }, { data: '0x095ea7b3', valueWei: '0' }).warnings[0]).toMatchObject({ unlimited: true });
    expect(evmWarnings({ ...base, kind: 'NativeTransfer', chainId: 31_337 }, { data: '0x', valueWei: '1' }).warnings).toEqual([{ kind: 'unknownChain', chainId: 31_337 }]);
    expect(evmWarnings({ ...base, kind: 'NativeTransfer', chainId: 424_242 }, { data: '0x', valueWei: '1' }).warnings).toEqual([{ kind: 'unknownChain', chainId: 424_242 }]);
    // Ethereum Classic (61) is not a Kyro chain (its pool refuses type-2 transactions).
    expect(evmWarnings({ ...base, kind: 'NativeTransfer', chainId: 61 }, { data: '0x', valueWei: '1' }).warnings).toEqual([{ kind: 'unknownChain', chainId: 61 }]);
    expect(evmWarnings({ ...base, kind: 'NativeTransfer', chainId: 999 }, { data: '0x', valueWei: '1' }).warnings).toEqual([]);
    expect(evmHighFeeThresholdWei(14)).toBe(2_000n * 10n ** 18n);
    const over = (evmHighFeeThresholdWei(1) + 1n).toString();
    expect(evmWarnings({ ...base, kind: 'NativeTransfer', chainId: 1, maxFeeWei: over }, { data: '0x', valueWei: '1' }).warnings).toEqual([{ kind: 'highFee', maxFeeWei: over }]);
    // Polygon's threshold is 50 POL: the same fee is fine there.
    expect(evmWarnings({ ...base, kind: 'NativeTransfer', chainId: 137, maxFeeWei: over }, { data: '0x', valueWei: '1' }).warnings).toEqual([]);
  });

  it('demo backend: evm_decode_tx carries them, evm_sign_tx asks a second time', async () => {
    const dialogs: string[] = [];
    setBackend(createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: 'correct horse', unlocked: true } }).invoke);
    const accounts = await call('accounts_get');
    const approve: EvmTxRequest = {
      chainId: 11_155_111,
      nonce: 3,
      to: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      valueWei: '0',
      data: '0x095ea7b3' + '0'.repeat(24) + accounts.evm.address.slice(2).toLowerCase() + 'f'.repeat(64),
      gasLimit: 60_000,
      maxFeePerGas: '20000000000',
      maxPriorityFeePerGas: '1000000000',
    };
    const s = await call('evm_decode_tx', { tx: approve });
    expect(s).toMatchObject({ kind: 'Erc20Approve', valueWei: '0', requiresExtraConfirmation: true });
    expect(s.warnings[0]).toMatchObject({ kind: 'approval', unlimited: true });
    await call('evm_sign_tx', { tx: approve, password: 'correct horse' });
    expect(dialogs).toHaveLength(2);
    expect(dialogs[1]).toMatch(/Signer quand même/);
    const plain = await call('evm_decode_tx', { tx: { ...approve, data: '0x', valueWei: '1000' } });
    expect(plain).toMatchObject({ kind: 'NativeTransfer', warnings: [], requiresExtraConfirmation: false });
  });
});
