// TRON end to end against the demo backend: typed tron_* commands, accounts_get, servers
// (TronGrid default, java-tron node without /v1), the resource estimate Rust shows before
// signing (bandwidth, simulated energy, fee_limit, activation), signing and broadcast.
import { beforeEach, describe, expect, it } from 'vitest';
import { call, IpcError, setBackend, type Accounts } from '@kyro/shared';
import { createMockBackend, demoTronAddress, type MockBackend } from '@kyro/shared/mock';
import { assetsFor, createAdapters, findAsset, isTronAddress, outgoingHosts, tronCoverage, TronAdapter, tronChain, WATCH_ONLY_CHAINS, type TronBackend } from '../src';

const PASSWORD = 'correct horse battery';
const NILE_USDT = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
let accounts: Accounts;
let mock: MockBackend;
let dialogs: string[];

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof IpcError ? e.code : (e as Error).message;
  }
  throw new Error('expected rejection');
}

beforeEach(async () => {
  dialogs = [];
  mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: PASSWORD, unlocked: true } });
  setBackend(mock.invoke);
  accounts = await call('accounts_get');
});

/** The demo's existing account that holds USDT (not us). */
const friend = () => [...mock.tron.trx.keys()].find((a) => a !== accounts.tron.address) ?? '';

describe('TRON in the app', () => {
  it('is a full chain now: TRX + Nile USDT, no longer « Bientôt », TronGrid in the outgoing list', () => {
    expect(WATCH_ONLY_CHAINS.map((w) => w.key)).not.toContain('tron');
    expect(findAsset('testnet', 'trx')).toMatchObject({ family: 'tron', kind: 'native', symbol: 'TRX', decimals: 6, chainKey: 'tron' });
    expect(findAsset('testnet', `trc20:${NILE_USDT}`)).toMatchObject({ family: 'tron', kind: 'trc20', symbol: 'USDT', decimals: 6, contract: NILE_USDT });
    expect(findAsset('mainnet', 'trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')?.symbol).toBe('USDT');
    expect(assetsFor('testnet').filter((a) => a.family === 'tron')).toHaveLength(2);
    expect(outgoingHosts('testnet').map((h) => h.host)).toContain('nile.trongrid.io');
    expect(outgoingHosts('mainnet').map((h) => h.host)).toContain('api.trongrid.io');
    const custom = outgoingHosts('testnet', { bitcoin: {}, evm: {}, solana: {}, litecoin: {}, dogecoin: {}, xrp: {}, cardano: {}, tron: { testnet: { kind: 'http', url: 'https://tron.my-node.example' } } });
    expect(custom.find((h) => h.host === 'tron.my-node.example')).toMatchObject({ custom: true });
    expect(custom.map((h) => h.host)).not.toContain('nile.trongrid.io');
  });

  it('vault account: real T… address (m/44’/195’/0’/0/0), adapter, balances', async () => {
    expect(isTronAddress(accounts.tron.address)).toBe(true);
    expect(await call('tron_address', { index: 0 })).toBe(accounts.tron.address);
    expect(await call('tron_address', { index: 1 })).not.toBe(accounts.tron.address);
    const ad = createAdapters(accounts);
    expect(ad.tron?.getAddress()).toBe(accounts.tron.address);
    expect(ad.all.map((a) => a.family)).toContain('tron');
    expect(await ad.tron!.getBalance()).toEqual([
      { assetId: 'trx', amount: 35_000_000n },
      { assetId: `trc20:${NILE_USDT}`, amount: 120_500_000n },
    ]);
    expect(await call('tron_backend_info')).toMatchObject({ kind: 'default', network: 'testnet', label: 'nile.trongrid.io' });
  });

  it('hardware-wallet accounts have no TRON adapter (HW_UNSUPPORTED)', () => {
    const { tron: _t, ltc: _l, doge: _d, ...hw } = accounts;
    const ad = createAdapters(hw, undefined, undefined, { accountId: 'hw-1', device: 'trezor' });
    expect(ad.tron).toBeNull();
    expect(ad.all.some((a) => a.family === 'tron')).toBe(false);
  });

  it('TRX to a new account: activation 1 TRX + 0.1 TRX, bandwidth covered, signed and broadcast', async () => {
    const tron = createAdapters(accounts).tron!;
    const fresh = demoTronAddress(new Uint8Array(64).fill(7), 0); // never funded
    const trx = findAsset('testnet', 'trx')!;
    const u = await tron.buildTx({ asset: trx, to: fresh, amount: 2_000_000n, fee: { family: 'tron' } });
    expect(u.estimate).toMatchObject({ recipientExists: false, activationFee: '1100000', bandwidthBurn: '0', energyNeeded: 0, totalBurn: '1100000', totalBurnMax: '1100000' });
    expect(u.maxFee).toBe(1_100_000n);
    expect(tronCoverage(u.estimate, u.amount)).toMatchObject({ expected: true, worst: true });
    const s = await tron.signTx(u, PASSWORD);
    expect(dialogs[0]).toContain("Ce compte n'existe pas encore sur TRON : l'activer brûle 1,1 TRX en plus");
    expect(dialogs[0]).toContain('Bande passante : 268 octets nécessaires · disponible 600 gratuite + 0 gelée');
    expect(await tron.broadcast(s)).toBe(s.txid);
    expect(mock.tron.trx.get(accounts.tron.address)).toBe(35_000_000n - 2_000_000n - 1_100_000n);
    expect((await tron.getHistory())[0]).toMatchObject({ direction: 'out', assetId: 'trx', amount: 2_000_000n, counterparty: fresh });
  });

  it('USDT: energy simulated, fee_limit = energy × price × 1.3, burn estimated and maximum', async () => {
    const tron = createAdapters(accounts).tron!;
    const usdt = findAsset('testnet', `trc20:${NILE_USDT}`)!;
    const u = await tron.buildTx({ asset: usdt, to: friend(), amount: 10_000_000n, fee: { family: 'tron' } });
    expect(u.token?.contract).toBe(NILE_USDT);
    // The recipient already holds USDT: 31 895 energy, none staked → 3.1895 TRX burned, fee_limit 4.14635 TRX.
    expect(u.estimate).toMatchObject({ energyNeeded: 31_895, energyAvailable: 0, energyFee: 100, energyBurn: '3189500', feeLimit: '4146350', recipientExists: true, bandwidthNeeded: 345 });
    expect(u.summary.feeLimit).toBe('4146350');
    expect(u.maxFee).toBe(4_146_350n);
    await tron.signTx(u, PASSWORD);
    expect(dialogs[0]).toContain('10 USDT (unités brutes : 10000000)');
    expect(dialogs[0]).toContain("TRX brûlés au maximum pour l'énergie (fee_limit) : 4,14635 TRX");
    // A first-time holder costs twice the energy.
    const first = await tron.buildTx({ asset: usdt, to: demoTronAddress(new Uint8Array(64).fill(9), 0), amount: 1_000_000n, fee: { family: 'tron' } });
    expect(first.estimate.energyNeeded).toBe(64_895);
    // More USDT than held: the simulation reverts, nothing is built.
    await expect(tron.buildTx({ asset: usdt, to: friend(), amount: 999_000_000n, fee: { family: 'tron' } })).rejects.toThrow(/solde de token insuffisant/);
  });

  it('coverage: the TRX balance must pay what is burned (warning / block in the UI)', async () => {
    const tron = createAdapters(accounts).tron!;
    const trx = findAsset('testnet', 'trx')!;
    const fresh = demoTronAddress(new Uint8Array(64).fill(3), 0);
    const u = await tron.buildTx({ asset: trx, to: fresh, amount: 34_500_000n, fee: { family: 'tron' } });
    expect(tronCoverage(u.estimate, u.amount)).toEqual({ expected: false, worst: false, missing: 600_000n, missingWorst: 600_000n });
    // The network refuses it too.
    const s = await tron.signTx(u, PASSWORD);
    expect(await code(tron.broadcast(s))).toBe('INVALID_INPUT');
    // A token with an empty TRX balance: blocked as well.
    mock.tron.trx.set(accounts.tron.address, 1_000_000n);
    const t = await tron.buildTx({ asset: findAsset('testnet', `trc20:${NILE_USDT}`)!, to: friend(), amount: 1_000_000n, fee: { family: 'tron' } });
    expect(tronCoverage(t.estimate, 0n)).toMatchObject({ expected: false, missing: 2_189_500n });
  });

  it('MAX TRX leaves exactly what the transfer may burn', async () => {
    const tron = createAdapters(accounts).tron!;
    const trx = findAsset('testnet', 'trx')!;
    const fresh = demoTronAddress(new Uint8Array(64).fill(5), 0);
    const u = await tron.buildTx({ asset: trx, to: fresh, amount: 0n, fee: { family: 'tron' }, max: true });
    expect(u.amount + BigInt(u.estimate.totalBurnMax)).toBe(35_000_000n);
    expect(tronCoverage(u.estimate, u.amount).worst).toBe(true);
  });

  it('servers: TronGrid default, java-tron node without /v1 (history only fails), wrong network', async () => {
    expect((await call('server_test', { target: { family: 'tron', network: 'testnet', server: { kind: 'default' } } })).detected).toMatchObject({ network: 'nile' });
    expect(await code(call('server_test', { target: { family: 'tron', network: 'testnet', server: { kind: 'http', url: 'https://wrong-tron.example' } } }))).toBe('SERVER_WRONG_NETWORK');
    expect(await code(call('server_test', { target: { family: 'tron', network: 'testnet', server: { kind: 'http', url: 'http://tron.example' } } }))).toBe('SERVER_INVALID');
    const s = await call('settings_get');
    await call('settings_set', { settings: { ...s, servers: { ...s.servers, tron: { testnet: { kind: 'http', url: 'https://tron.my-node.example' } } } } });
    expect(await call('tron_backend_info')).toMatchObject({ kind: 'http', label: 'tron.my-node.example' });
    const tron = createAdapters(accounts).tron!;
    expect((await tron.getBalance())[0]?.amount).toBe(35_000_000n);
    await expect(tron.getHistory()).rejects.toThrow(/exige l'API \/v1 de TronGrid/);
    expect(await code(call('tron_txs', { address: accounts.tron.address }))).toBe('SERVER_UNREACHABLE');
  });

  it('unknown TRC-20: the UI hint goes to Rust (« non vérifié »), never for USDT', async () => {
    const seen: Array<{ symbol: string; decimals: number } | undefined> = [];
    const real = createAdapters(accounts).tron!;
    const ME = accounts.tron.address;
    const FAKE = 'TFz2CJn9CJb8C4i1Gke3jmZX2fRMJxniH2';
    const backend: TronBackend = {
      account: (a) => call('tron_account', { address: a }),
      trc20Balance: async () => '5',
      txs: async () => [],
      build: async (to, amount, token) => ({
        raw: '00',
        txid: 'ab'.repeat(32),
        summary: { txid: 'ab'.repeat(32), owner: ME, action: { type: 'trc20Transfer', contract: token ?? '', to, amount, callValue: '0' }, feeLimit: '1000000', expiration: 1, timestamp: 0, refBlockBytes: '0000', refBlockHash: '00'.repeat(8), memo: '', rawSize: 209, warnings: [], requiresExtraConfirmation: false },
        estimate: (await real.buildTx({ asset: findAsset('testnet', 'trx')!, to: friend(), amount: 1n, fee: { family: 'tron' } })).estimate,
      }),
      sign: async (_raw, _pw, token) => {
        seen.push(token);
        return { signature: 'cd'.repeat(65), txid: 'ab'.repeat(32), summary: null as never, estimate: null as never };
      },
      broadcast: async () => 'ab'.repeat(32),
    };
    const a = new TronAdapter({ chain: tronChain('testnet'), address: ME, backend, tokens: [{ contract: NILE_USDT, symbol: 'USDT', name: 'Tether USD', decimals: 6 }, { contract: FAKE, symbol: 'FAKE', name: 'Fake', decimals: 2 }] });
    await a.signTx(await a.buildTransfer({ to: friend(), amount: 5n, token: a.tokens[1]! }), PASSWORD);
    await a.signTx(await a.buildTransfer({ to: friend(), amount: 5n, token: a.tokens[0]! }), PASSWORD);
    expect(seen).toEqual([{ symbol: 'FAKE', decimals: 2 }, undefined]);
  });
});
