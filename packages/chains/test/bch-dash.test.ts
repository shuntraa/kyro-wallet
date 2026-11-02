// Bitcoin Cash / Dash end to end against the demo backend (typed bch_* / dash_* commands,
// accounts_get, servers, dust, signing with the previous transaction checked, broadcast), and the
// TypeScript side of the official vectors (Trezor `all ×12`, same addresses as wallet-core).
import { beforeEach, describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { HDKey } from '@scure/bip32';
import { call, IpcError, setBackend, type Accounts } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { assetsFor, BitcoinCashAdapter, bchChain, bchDashDust, createAdapters, dashChain, DashAdapter, findAsset, outgoingHosts, sameAddress, type UtxoBackend } from '../src';

const PASSWORD = 'correct horse battery';
/**
 * BIP39 seed of Trezor's public test phrase `all ×12` (no passphrase): PBKDF2-HMAC-SHA512 of
 * the phrase, salt `mnemonic`, 2 048 rounds — the seed of trezor-firmware's `all_all_all` fixtures.
 */
const ALL_SEED = Uint8Array.from('c76c4ac4f4e4a00d6b274d5c39c700bb4a7ddc04fbc6f78e85ca75007b5b495f74a9043eeb77bdd53aa6fc3a0e31462270316fa04b8c19114c8798706cd02ac8'.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
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

/** Account view of `all ×12` at `path` (what Rust's `accounts_get` returns for that wallet). */
function trezorAccount(path: string, first: string) {
  const master = HDKey.fromMasterSeed(ALL_SEED);
  const node = master.derive(path);
  return { address: first, xpub: node.publicExtendedKey, fingerprint: master.fingerprint.toString(16).padStart(8, '0'), path };
}

const noBackend = {} as UtxoBackend;

describe('Bitcoin Cash and Dash: official vectors on the TypeScript side', () => {
  it('Trezor test_bch addresses from the account xpub (CashAddr), same as wallet-core', () => {
    const acc = trezorAccount("m/44'/145'/0'", 'bitcoincash:qr08q88p9etk89wgv05nwlrkm4l0urz4cyl36hh9sv');
    const bch = new BitcoinCashAdapter({ chain: bchChain('mainnet'), account: acc, backend: noBackend });
    expect(bch.addressAt(0, 1).address).toBe('bitcoincash:qr23ajjfd9wd73l87j642puf8cad20lfmqdgwvpat4');
    expect(bch.addressAt(1, 0).address).toBe('bitcoincash:qzc5q87w069lzg7g3gzx0c8dz83mn7l02scej5aluw');
    // CashAddr only: the legacy form of the same key, a Bitcoin address, chipnet: refused.
    expect(bch.isValidAddress('bitcoincash:qr23ajjfd9wd73l87j642puf8cad20lfmqdgwvpat4')).toBe(true);
    expect(bch.isValidAddress('qr23ajjfd9wd73l87j642puf8cad20lfmqdgwvpat4')).toBe(true);
    expect(bch.isValidAddress('BITCOINCASH:QR23AJJFD9WD73L87J642PUF8CAD20LFMQDGWVPAT4')).toBe(true);
    expect(bch.isValidAddress('1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu')).toBe(false);
    expect(bch.isValidAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')).toBe(false);
    expect(bch.isValidAddress('bchtest:qr23ajjfd9wd73l87j642puf8cad20lfmqdgwvpat4')).toBe(false);
    expect(bch.isValidAddress('bitcoincash:qr23ajjfd9wd73l87j642puf8cad20lfmqdgwvpat5')).toBe(false);
  });

  it('Trezor test_dash address from the account xpub, X… only', () => {
    const acc = trezorAccount("m/44'/5'/0'", 'XdTw4G5AWW4cogGd7ayybyBNDbuB45UpgH');
    const dash = new DashAdapter({ chain: dashChain('mainnet'), account: acc, backend: noBackend });
    expect(dash.isValidAddress('XpTc36DPAeWmaueNBA9JqCg2GC8XDLKSYe')).toBe(true);
    expect(dash.isValidAddress('7eprxeVjKfVgS8p2RNsZ89K72YV61xg4gq')).toBe(true);
    expect(dash.isValidAddress('D5taDndQJ1fDF3AM1yWavmJY2BgSi17CUv')).toBe(false);
    expect(dash.isValidAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(false);
    expect(dash.isValidAddress('xdash1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')).toBe(false);
    // A wrong first address (vault and xpub disagree): refused at construction.
    expect(() => new DashAdapter({ chain: dashChain('mainnet'), account: { ...acc, address: 'XpTc36DPAeWmaueNBA9JqCg2GC8XDLKSYe' }, backend: noBackend })).toThrow(/incohérente/i);
  });

  it('dust 546 for P2PKH (Bitcoin Cash Node / Dash Core), 540 for P2SH', () => {
    expect(bchDashDust('p2pkh')).toBe(546n);
    expect(bchDashDust('p2sh')).toBe(540n);
  });

  it('CashAddr comparison for poisoning checks ignores the prefix and the case', () => {
    expect(sameAddress('bitcoincash:qr23ajjfd9wd73l87j642puf8cad20lfmqdgwvpat4', 'QR23AJJFD9WD73L87J642PUF8CAD20LFMQDGWVPAT4', 'bch')).toBe(true);
    expect(sameAddress('XpTc36DPAeWmaueNBA9JqCg2GC8XDLKSYe', 'xpTc36DPAeWmaueNBA9JqCg2GC8XDLKSYe', 'dash')).toBe(false);
  });
});

describe('Bitcoin Cash and Dash in the app (demo backend)', () => {
  it('are full chains: assets, accounts, adapters, prices', () => {
    expect(findAsset('testnet', 'bch')).toMatchObject({ family: 'bch', symbol: 'BCH', decimals: 8, kind: 'native', coingeckoId: 'bitcoin-cash' });
    expect(findAsset('mainnet', 'dash')).toMatchObject({ family: 'dash', symbol: 'DASH', decimals: 8, coingeckoId: 'dash' });
    expect(accounts.bch.address.startsWith('bchtest:q')).toBe(true);
    expect(accounts.bch.path).toBe("m/44'/1'/0'");
    expect(accounts.dash.address.startsWith('y')).toBe(true);
    const ad = createAdapters(accounts);
    expect(ad.bch?.getAddress()).toBe(accounts.bch.address);
    expect(ad.dash?.getAddress()).toBe(accounts.dash.address);
    expect(ad.all.map((a) => a.family)).toEqual(expect.arrayContaining(['bch', 'dash']));
    expect(assetsFor('mainnet').filter((a) => a.family === 'bch' || a.family === 'dash')).toHaveLength(2);
  });

  it('Bitcoin Cash chipnet: default Fulcrum server, balance, build (CashAddr by script), Rust returns it finalized, broadcast', async () => {
    expect(await call('bch_backend_info')).toMatchObject({ kind: 'default', label: 'chipnet.imaginary.cash', available: true, network: 'testnet' });
    const bch = createAdapters(accounts).bch!;
    expect((await bch.getBalance())[0]).toEqual({ assetId: 'bch', amount: 84_000_000n + 6_250_000n });
    const fees = await bch.estimateFees();
    expect(fees.hint).toBe('1 sat/octet');
    const asset = findAsset('testnet', 'bch')!;
    const to = (await call('bch_address', { change: false, index: 3 })) as string;
    expect(to.startsWith('bchtest:q')).toBe(true);
    const unsigned = await bch.buildTx({ asset, to, amount: 10_000_000n, fee: fees.options.normal.params });
    expect(unsigned.summary.outputs[0]?.[0]).toBe(to);
    const psbt = bitcoin.Psbt.fromBase64(unsigned.psbt);
    expect(psbt.data.inputs.every((i) => i.nonWitnessUtxo && !i.witnessUtxo)).toBe(true);
    // 1 sat/B: 226 bytes for 1 input, 2 outputs.
    expect(unsigned.fee).toBe(226n);
    const signed = await bch.signTx(unsigned, PASSWORD);
    expect(signed.summary).toMatchObject({ coin: 'bitcoincash', hasChange: true });
    // scriptSig = <sig ‖ sighash> <pubkey>: the last byte of the signature push is SIGHASH_ALL|FORKID.
    const scriptSig = bitcoin.Transaction.fromHex(signed.hex).ins[0]!.script;
    expect(scriptSig[scriptSig[0]!]).toBe(0x41);
    expect(await bch.broadcast(signed)).toBe(signed.txid);
    expect((await bch.getHistory()).length).toBeGreaterThan(0);
    // Below the dust limit: refused before anything is built.
    expect(await code(bch.buildTx({ asset, to, amount: 545n, fee: fees.options.normal.params }))).toMatch(/poussière/i);
    expect(await code(bch.buildTx({ asset, to: '1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu', amount: 10_000n, fee: fees.options.normal.params }))).toMatch(/invalide/i);
  });

  it('Dash testnet: no default server → SERVER_INVALID; works once configured; mainnet out of the box', async () => {
    expect(await call('dash_backend_info')).toMatchObject({ kind: 'default', available: false, label: '' });
    const dash = createAdapters(accounts).dash!;
    expect(await code(dash.getBalance())).toBe('SERVER_INVALID');
    expect(await code(call('server_test', { target: { family: 'dash', network: 'testnet', server: { kind: 'default' } } }))).toBe('SERVER_INVALID');
    const s = await call('settings_get');
    await call('settings_set', { settings: { ...s, servers: { ...s.servers, dash: { testnet: { kind: 'esplora', url: 'https://my-dash.example/api' } } } } });
    expect((await dash.getBalance())[0]?.amount).toBe(312_000_000n + 45_000_000n);

    setBackend(createMockBackend({ network: 'mainnet', confirm: () => true, preset: { password: PASSWORD, unlocked: true } }).invoke);
    const main = await call('accounts_get');
    expect(main.dash.address.startsWith('X')).toBe(true);
    expect(main.bch.address.startsWith('bitcoincash:q')).toBe(true);
    expect(await call('dash_backend_info')).toMatchObject({ available: true, label: 'dash.electrum1.cipig.net' });
    expect(await call('bch_backend_info')).toMatchObject({ available: true, label: 'bch.imaginary.cash' });
    const d = createAdapters(main).dash!;
    const fee = (await d.estimateFees()).options.normal.params;
    const unsigned = await d.buildTx({ asset: findAsset('mainnet', 'dash')!, to: main.dash.address, amount: 100_000_000n, fee });
    const signed = await d.signTx(unsigned, PASSWORD);
    expect(signed.summary.coin).toBe('dash');
    expect(BigInt(signed.summary.fee)).toBe(unsigned.fee);
  });

  it('the signing account is the chosen one (multi-accounts)', async () => {
    const acc1 = await call('accounts_get', { account: 1 });
    expect(acc1.bch.path).toBe("m/44'/1'/1'");
    expect(acc1.dash.path).toBe("m/44'/1'/1'");
    expect(acc1.bch.address).not.toBe(accounts.bch.address);
    expect(await call('bch_address', { change: false, index: 0, account: 1 })).toBe(acc1.bch.address);
    await call('vault_account_add', { chain: 'bch', account: 1, name: 'BCH épargne' });
    expect((await call('vault_accounts_get')).bch.map((e) => e.index)).toEqual([0, 1]);
  });

  it('outgoing hosts list the new defaults (and no Dash testnet server)', () => {
    const main = outgoingHosts('mainnet').map((h) => h.host);
    expect(main).toEqual(expect.arrayContaining(['bch.imaginary.cash:50002', 'bch.loping.net:50002', 'cashnode.bch.ninja:50002', 'dash.electrum1.cipig.net:20061', 'dash.electrum2.cipig.net:20061']));
    const test = outgoingHosts('testnet');
    expect(test.map((h) => h.host)).toEqual(expect.arrayContaining(['chipnet.imaginary.cash:50002', 'chipnet.bch.ninja:50002']));
    expect(test.some((h) => h.purpose.startsWith('Dash testnet : aucun serveur'))).toBe(true);
  });
});
