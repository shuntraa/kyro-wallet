// Zcash (transparent addresses only) end to end against the demo backend: typed zec_* commands,
// accounts_get, address rules (shielded / unified refused with a clear message, TEX accepted),
// mainnet default server and none on testnet, Rust-built send (ZIP 317, change to us), broadcast.
import { beforeEach, describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { call, IpcError, setBackend, zecDestinationKind, zecP2pkhAddress, zecShieldedRefusal, type Accounts } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { addressParts, assetsFor, createAdapters, findAsset, isLookalike, outgoingHosts, zecAddressProblem, zecChain } from '../src';

const PASSWORD = 'correct horse battery';

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof IpcError ? e.code : (e as Error).message;
  }
  throw new Error('expected rejection');
}

const SAPLING = 'zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly';
const UNIFIED = 'u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf';
/** ZIP 320 example: the same key hash as t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC. */
const TEX = 'tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte';
const T1 = 't1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC';

describe('Zcash transparent address helpers', () => {
  it('accepts t1 / t3 / tex1, refuses shielded and unified with an explanation', () => {
    expect(zecDestinationKind(T1, 'mainnet')).toBe('p2pkh');
    expect(zecDestinationKind(TEX, 'mainnet')).toBe('tex');
    expect(zecDestinationKind(T1, 'testnet')).toBeNull();
    expect(zecDestinationKind(SAPLING, 'mainnet')).toBeNull();
    expect(zecShieldedRefusal(SAPLING)).toMatch(/protégée Sapling.*pas encore prise en charge/);
    expect(zecShieldedRefusal(UNIFIED)).toMatch(/unifiée.*pas encore prise en charge/);
    expect(zecShieldedRefusal(T1)).toBeNull();
    expect(zecAddressProblem(SAPLING, 'mainnet')).toMatch(/protégée/);
    expect(zecAddressProblem(UNIFIED, 'mainnet')).toMatch(/unifiée/);
    expect(zecAddressProblem(T1, 'testnet')).toMatch(/mainnet/);
    expect(zecAddressProblem(T1.slice(0, -1) + 'D', 'mainnet')).toMatch(/invalide/);
    expect(zecAddressProblem(T1, 'mainnet')).toBeNull();
    expect(zecAddressProblem('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'mainnet')).toMatch(/invalide/);
  });

  it('derives t1 / tm addresses like Rust (BIP44 m/44\'/133\'/0\', hash160, prefix 0x1cb8)', () => {
    const seed = new Uint8Array(64).fill(7);
    const pk = HDKey.fromMasterSeed(seed).derive("m/44'/133'/0'/0/0").publicKey!;
    const a = zecP2pkhAddress(pk, 'mainnet');
    expect(a.startsWith('t1')).toBe(true);
    expect(zecDestinationKind(a, 'mainnet')).toBe('p2pkh');
    expect(zecP2pkhAddress(pk, 'testnet').startsWith('tm')).toBe(true);
  });

  it('poisoning check compares the body after t1 (or tex1)', () => {
    expect(addressParts(T1, 'zec')).toMatchObject({ prefix: 't1', caseInsensitive: false });
    expect(addressParts(TEX, 'zec')).toMatchObject({ prefix: 'tex1', caseInsensitive: true });
    const lookalike = `t1${T1.slice(2, 6)}XXXXXXXXXXXXXXXXXXXXXXXXX${T1.slice(-4)}`;
    expect(isLookalike(lookalike, T1, 'zec')).toBe(true);
    expect(isLookalike(T1, T1, 'zec')).toBe(false);
  });
});

describe('Zcash in the app (demo backend)', () => {
  let accounts: Accounts;
  beforeEach(async () => {
    setBackend(createMockBackend({ network: 'mainnet', confirm: () => true, preset: { password: PASSWORD, unlocked: true } }).invoke);
    accounts = await call('accounts_get');
  });

  it('is a full chain: asset, adapter, price id, outgoing hosts', () => {
    expect(findAsset('mainnet', 'zec')).toMatchObject({ family: 'zec', symbol: 'ZEC', decimals: 8, kind: 'native', coingeckoId: 'zcash' });
    expect(zecChain('mainnet')).toMatchObject({ transparentOnly: true, key: 'zcash' });
    expect(accounts.zec.path).toBe("m/44'/133'/0'");
    expect(accounts.zec.address.startsWith('t1')).toBe(true);
    const ad = createAdapters(accounts);
    expect(ad.zec?.getAddress()).toBe(accounts.zec.address);
    expect(ad.all.map((a) => a.family)).toContain('zec');
    expect(assetsFor('mainnet').filter((a) => a.family === 'zec')).toHaveLength(1);
    expect(outgoingHosts('mainnet').map((h) => h.host)).toEqual(expect.arrayContaining(['zec.electrum1.cipig.net:20058', 'zec.electrum2.cipig.net:20058']));
  });

  it('balance, preview built by Rust (ZIP 317, change to us), sign, broadcast, history', async () => {
    expect(await call('zec_backend_info')).toMatchObject({ kind: 'default', available: true, label: 'zec.electrum1.cipig.net', network: 'mainnet' });
    const zec = createAdapters(accounts).zec!;
    expect((await zec.getBalance())[0]).toEqual({ assetId: 'zec', amount: 184_250_000n + 12_500_000n });
    const fees = await zec.estimateFees();
    expect(fees.options.normal.params).toEqual({ family: 'zec' });
    const unsigned = await zec.buildTx({ asset: findAsset('mainnet', 'zec')!, to: T1, amount: 50_000_000n, fee: fees.options.normal.params });
    expect(unsigned.family).toBe('zec');
    // The request carries outpoints and our address indices only, never amounts.
    expect(unsigned.request.coins.every((c) => Object.keys(c).sort().join() === 'change,index,txid,vout')).toBe(true);
    expect(unsigned.summary).toMatchObject({ inputs: 1, fee: '10000', zip317Fee: '10000', upgrade: 'NU6.3', amount: '50000000' });
    expect(unsigned.summary.change?.amount).toBe(String(184_250_000 - 50_000_000 - 10_000));
    expect(unsigned.summary.change?.address.startsWith('t1')).toBe(true);
    const signed = await zec.signTx(unsigned, PASSWORD);
    expect(signed.txid).toBe(unsigned.summary.txid);
    expect(await zec.broadcast(signed)).toBe(signed.txid);
    const history = await zec.getHistory();
    expect(history.some((h) => h.id === signed.txid && h.direction === 'out')).toBe(true);
  });

  it('refuses shielded / unified recipients before building, and in the backend', async () => {
    const zec = createAdapters(accounts).zec!;
    expect(zec.isValidAddress(SAPLING)).toBe(false);
    expect(zec.isValidAddress(UNIFIED)).toBe(false);
    expect(zec.isValidAddress(TEX)).toBe(true);
    await expect(zec.buildTx({ asset: findAsset('mainnet', 'zec')!, to: SAPLING, amount: 1_000n, fee: { family: 'zec' } })).rejects.toThrow(/protégée/);
    const coins = [{ txid: '00'.repeat(32), vout: 0, change: false, index: 0 }];
    expect(await code(call('zec_send_preview', { request: { to: UNIFIED, amount: '1000', max: false, coins, changeIndex: 0 } }))).toBe('INVALID_INPUT');
  });

  it('send everything: no change, ZIP-317 fee for 2 inputs', async () => {
    const zec = createAdapters(accounts).zec!;
    const u = await zec.buildTx({ asset: findAsset('mainnet', 'zec')!, to: T1, amount: 0n, max: true, fee: { family: 'zec' } });
    expect(u.summary).toMatchObject({ inputs: 2, change: null, fee: '10000', amount: String(184_250_000 + 12_500_000 - 10_000) });
  });
});

describe('Zcash testnet (demo backend)', () => {
  it('has no public server: SERVER_INVALID, said by backend_info', async () => {
    setBackend(createMockBackend({ network: 'testnet', confirm: () => true, preset: { password: PASSWORD, unlocked: true } }).invoke);
    const accounts = await call('accounts_get');
    expect(accounts.zec.address.startsWith('tm')).toBe(true);
    expect(await call('zec_backend_info')).toMatchObject({ available: false, label: '' });
    const zec = createAdapters(accounts).zec!;
    expect(await code(zec.getBalance())).toBe('SERVER_INVALID');
    expect(outgoingHosts('testnet').some((h) => h.purpose.startsWith('Zcash testnet'))).toBe(true);
  });
});
