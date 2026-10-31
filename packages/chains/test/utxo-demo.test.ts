// Litecoin / Dogecoin end to end against the demo backend: typed ltc_* / doge_* commands,
// accounts_get, servers (Dogecoin: public ElectrumX default on mainnet, none on testnet), dust
// rules, signing (previous transaction checked) and broadcast.
import { beforeEach, describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { call, IpcError, setBackend, type Accounts } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { assetsFor, createAdapters, findAsset, WATCH_ONLY_CHAINS, DOGE_SOFT_DUST } from '../src';

const PASSWORD = 'correct horse battery';
let accounts: Accounts;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof IpcError ? e.code : (e as Error).message;
  }
  throw new Error('expected rejection');
}

beforeEach(async () => {
  setBackend(createMockBackend({ network: 'testnet', confirm: () => true, preset: { password: PASSWORD, unlocked: true } }).invoke);
  accounts = await call('accounts_get');
});

describe('Litecoin and Dogecoin in the app', () => {
  it('are full chains now: assets, adapters, no longer « Bientôt »', () => {
    expect(WATCH_ONLY_CHAINS.map((w) => w.key)).not.toContain('litecoin');
    expect(WATCH_ONLY_CHAINS.map((w) => w.key)).not.toContain('dogecoin');
    expect(findAsset('testnet', 'ltc')).toMatchObject({ family: 'ltc', symbol: 'LTC', decimals: 8, kind: 'native' });
    expect(findAsset('testnet', 'doge')).toMatchObject({ family: 'doge', symbol: 'DOGE', decimals: 8 });
    const ad = createAdapters(accounts);
    expect(ad.ltc?.getAddress()).toBe(accounts.ltc.address);
    expect(accounts.ltc.address.startsWith('tltc1q')).toBe(true);
    expect(ad.doge?.getAddress()).toBe(accounts.doge.address);
    expect(ad.all.map((a) => a.family)).toEqual(expect.arrayContaining(['ltc', 'doge']));
    expect(assetsFor('testnet').filter((a) => a.family === 'ltc' || a.family === 'doge')).toHaveLength(2);
  });

  it('Litecoin: default server (litecoinspace.org), balance, build, sign in Rust, broadcast', async () => {
    expect(await call('ltc_backend_info')).toMatchObject({ kind: 'default', label: 'litecoinspace.org', available: true, network: 'testnet' });
    const ltc = createAdapters(accounts).ltc!;
    expect((await ltc.getBalance())[0]).toEqual({ assetId: 'ltc', amount: 125_000_000n + 30_500_000n });
    const fees = await ltc.estimateFees();
    expect(fees.hint).toBe('2 litoshi/vB');
    const unsigned = await ltc.buildTx({ asset: findAsset('testnet', 'ltc')!, to: accounts.ltc.address, amount: 10_000_000n, fee: fees.options.normal.params });
    expect(unsigned.family).toBe('btc');
    const signed = await ltc.signTx(unsigned, PASSWORD);
    expect(signed.summary).toMatchObject({ coin: 'litecoin', hasChange: true });
    expect(await ltc.broadcast(signed)).toBe(signed.txid);
    expect((await ltc.getHistory()).length).toBeGreaterThan(0);
  });

  it('Dogecoin testnet: no default server → SERVER_INVALID (never pretends to load); works once configured', async () => {
    expect(await call('doge_backend_info')).toMatchObject({ kind: 'default', available: false, label: '' });
    const doge = createAdapters(accounts).doge!;
    expect(await code(doge.getBalance())).toBe('SERVER_INVALID');
    expect(await code(call('server_test', { target: { family: 'dogecoin', network: 'testnet', server: { kind: 'default' } } }))).toBe('SERVER_INVALID');
    expect(await code(call('server_test', { target: { family: 'dogecoin', network: 'testnet', server: { kind: 'esplora', url: 'https://wrong-doge.example/api' } } }))).toBe('SERVER_WRONG_NETWORK');

    const s = await call('settings_get');
    await call('settings_set', { settings: { ...s, servers: { ...s.servers, dogecoin: { testnet: { kind: 'esplora', url: 'https://my-doge.example/api' } } } } });
    expect(await call('doge_backend_info')).toMatchObject({ kind: 'esplora', available: true, label: 'my-doge.example' });
    expect((await doge.getBalance())[0]?.amount).toBe(420_000_000_000n + 150_000_000n);
  });

  it('Dogecoin mainnet: works out of the box (Komodo ElectrumX default), custom server still possible', async () => {
    setBackend(createMockBackend({ network: 'mainnet', confirm: () => true, preset: { password: PASSWORD, unlocked: true } }).invoke);
    const main = await call('accounts_get');
    expect(await call('doge_backend_info')).toMatchObject({ kind: 'default', available: true, label: 'doge.electrum1.cipig.net', network: 'mainnet' });
    expect((await call('server_test', { target: { family: 'dogecoin', network: 'mainnet', server: { kind: 'default' } } })).detected).toMatchObject({ network: 'mainnet' });
    const doge = createAdapters(main).doge!;
    expect(main.doge.address.startsWith('D')).toBe(true);
    expect((await doge.getBalance())[0]?.amount).toBe(420_000_000_000n + 150_000_000n);
    expect((await doge.getHistory()).length).toBeGreaterThan(0);
    const asset = findAsset('mainnet', 'doge')!;
    const fee = (await doge.estimateFees()).options.normal.params;
    const unsigned = await doge.buildTx({ asset, to: main.doge.address, amount: 100_000_000n, fee });
    const signed = await doge.signTx(unsigned, PASSWORD);
    expect(await doge.broadcast(signed)).toBe(signed.txid);
    const s = await call('settings_get');
    await call('settings_set', { settings: { ...s, servers: { ...s.servers, dogecoin: { mainnet: { kind: 'esplora', url: 'https://my-doge.example/api' } } } } });
    expect(await call('doge_backend_info')).toMatchObject({ kind: 'esplora', available: true, label: 'my-doge.example' });
  });

  it('Dogecoin signing: the previous transaction must match the outpoint and pay us (demo mirrors Rust)', async () => {
    const doge = createAdapters(accounts).doge!;
    const s = await call('settings_get');
    await call('settings_set', { settings: { ...s, servers: { ...s.servers, dogecoin: { testnet: { kind: 'esplora', url: 'https://my-doge.example/api' } } } } });
    const asset = findAsset('testnet', 'doge')!;
    const fee = (await doge.estimateFees()).options.normal.params;
    const unsigned = await doge.buildTx({ asset, to: accounts.doge.address, amount: 100_000_000n, fee });
    const psbt = bitcoin.Psbt.fromBase64(unsigned.psbt);
    const prev = bitcoin.Transaction.fromBuffer(psbt.data.inputs[0]!.nonWitnessUtxo!);
    // A previous transaction forged to claim another amount no longer hashes to the outpoint.
    const forged = prev.clone();
    forged.outs[psbt.txInputs[0]!.index]!.value += 1_000_000n;
    psbt.data.inputs[0]!.nonWitnessUtxo = forged.toBuffer();
    await expect(call('doge_sign_psbt', { psbt: psbt.toBase64(), password: PASSWORD })).rejects.toThrow(/ne correspond pas à l’outpoint/);
  });

  it('Dogecoin dust: recipient < 0.01 DOGE refused; change < 0.01 DOGE goes to fees (no change output)', async () => {
    const mock = createMockBackend({ network: 'testnet', confirm: () => true, preset: { password: PASSWORD, unlocked: true } });
    setBackend(mock.invoke);
    // Only the 1.5 DOGE coin.
    const coins = mock.chain.dogeUtxos.get(accounts.doge.address) ?? [];
    mock.chain.dogeUtxos.set(accounts.doge.address, coins.filter((c) => c.value === 150_000_000));
    const s = await call('settings_get');
    await call('settings_set', { settings: { ...s, servers: { ...s.servers, dogecoin: { testnet: { kind: 'esplora', url: 'https://my-doge.example/api' } } } } });
    const doge = createAdapters(accounts).doge!;
    const asset = findAsset('testnet', 'doge')!;
    const fee = (await doge.estimateFees()).options.normal.params;
    await expect(doge.buildTx({ asset, to: accounts.doge.address, amount: DOGE_SOFT_DUST - 1n, fee })).rejects.toThrow(/poussière/);
    // Spend the 1.5 DOGE coin leaving a remainder under 0.01 DOGE: folded into the fee.
    const total = 150_000_000n;
    const feeNoChange = 192n * 1000n; // 10 + 148 + 34 bytes (1 input, 1 output P2PKH) × 1000 koinus/byte
    const unsigned = await doge.buildTx({ asset, to: accounts.doge.address, amount: total - feeNoChange - 500_000n, fee });
    expect(unsigned.dustFolded).toBeGreaterThan(0n);
    expect(unsigned.summary.outputs.some((o) => o[2])).toBe(false);
    const psbt = bitcoin.Psbt.fromBase64(unsigned.psbt);
    expect(psbt.data.inputs.every((i) => i.nonWitnessUtxo && !i.witnessUtxo)).toBe(true);
    const signed = await doge.signTx(unsigned, PASSWORD);
    expect(signed.summary.hasChange).toBe(false);
    expect(await doge.broadcast(signed)).toBe(signed.txid);
  });

  it('ltc_* / doge_* validate addresses for their chain', async () => {
    expect(await code(call('ltc_address_info', { address: accounts.btc.segwit.address }))).toBe('INVALID_INPUT');
    expect(await call('ltc_address', { change: false, index: 0 })).toBe(accounts.ltc.address);
    expect(await call('doge_address', { change: false, index: 0 })).toBe(accounts.doge.address);
  });
});
