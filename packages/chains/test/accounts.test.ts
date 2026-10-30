// Several vault accounts per chain (docs/IPC.md §2.9) against the demo backend: adapters of
// account 1 read their own addresses and carry `account` into every signing command.
import { beforeEach, describe, expect, it } from 'vitest';
import { call, setBackend } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { accountArg, createAdapters, findAsset } from '../src';

const PASSWORD = 'correct horse battery';
let dialogs: string[];

beforeEach(() => {
  dialogs = [];
  setBackend(
    createMockBackend({
      network: 'testnet',
      confirm: (t) => {
        dialogs.push(t);
        return true;
      },
      preset: { password: PASSWORD, unlocked: true },
    }).invoke,
  );
});

describe('vault accounts in the adapters', () => {
  it('accountArg: nothing for account 0 (calls unchanged), { account } otherwise', () => {
    expect(accountArg(0)).toEqual({});
    expect(accountArg(undefined)).toEqual({});
    expect(accountArg(3)).toEqual({ account: 3 });
  });

  it('account 1: own addresses and balances, Bitcoin signed by account 1', async () => {
    await call('vault_account_add', { chain: 'btc', account: 1, name: 'Bitcoin 2' });
    const a0 = await call('accounts_get');
    const a1 = await call('accounts_get', { account: 1 });
    const ad1 = createAdapters(a1, undefined, undefined, undefined, 1);
    const ad0 = createAdapters(a0);
    expect(ad1.btc?.account).toBe(1);
    expect(ad0.btc?.account).toBe(0);
    expect(ad1.evm.get('sepolia')?.getAddress()).toBe(a1.evm.address);
    expect(ad1.evm.get('sepolia')?.account).toBe(1);
    expect(ad1.sol?.account).toBe(1);
    // The demo funds account 1 with 0.0125 tBTC and 0.215 SepoliaETH.
    const btc = ad1.btc!;
    expect((await btc.getBalance())[0]?.amount).toBe(1_250_000n);
    const fees = await btc.estimateFees();
    const unsigned = await btc.buildTx({ asset: findAsset('testnet', 'btc')!, to: a0.btc.segwit.address, amount: 100_000n, fee: fees.options.normal.params });
    await btc.signTx(unsigned, PASSWORD);
    expect(dialogs[0]).toContain("Compte signataire : Bitcoin 2 — m/84'/1'/1' (SegWit), m/86'/1'/1' (Taproot)");
    expect(dialogs).toHaveLength(1);
  });

  it('EVM account outside the list: « inconnu » and a reinforced dialog', async () => {
    const a3 = await call('accounts_get', { account: 3 });
    const evm = createAdapters(a3, undefined, undefined, undefined, 3).evm.get('sepolia')!;
    const tx = { chainId: 11155111, nonce: 0, to: a3.evm.address, valueWei: '1', data: '0x', gasLimit: 21_000, maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000000' };
    await evm.signTx({ family: 'evm', tx } as never, PASSWORD);
    expect(dialogs[0]).toContain("« inconnu » (n° 4 Ethereum, absent de ta liste) — m/44'/60'/0'/0/3");
    expect(dialogs[1]).toContain('PAS dans ta liste');
  });
});
