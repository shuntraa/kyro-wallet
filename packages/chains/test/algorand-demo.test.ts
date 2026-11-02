// Algorand end to end against the demo backend: typed algo_* commands, accounts_get, minimum
// balance and spendable, the receiver minimum (0.1 ALGO), notes, the strict decoding (close,
// rekey, other network), confirmation follow-up, outgoing hosts.
import { beforeEach, describe, expect, it } from 'vitest';
import { call, IpcError, isAlgoAddress, setBackend, type Accounts } from '@kyro/shared';
import { algoAddressOf, createMockBackend, type MockBackend } from '@kyro/shared/mock';
import { algorandChain, assetsFor, createAdapters, findAsset, nativeAssetId, outgoingHosts } from '../src';

const PASSWORD = 'correct horse battery';
let accounts: Accounts;
let mock: MockBackend;
let dialogs: string[];

async function err(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e instanceof IpcError ? { code: e.code, message: e.message } : { code: 'JS', message: (e as Error).message };
  }
  throw new Error('expected rejection');
}

const hex = (o: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(o)), (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => JSON.parse(new TextDecoder().decode(new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16))))) as Record<string, unknown>;
const ALGO = findAsset('testnet', 'algo')!;

beforeEach(async () => {
  dialogs = [];
  mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: PASSWORD, unlocked: true } });
  setBackend(mock.invoke);
  accounts = await call('accounts_get');
});

describe('Algorand addresses', () => {
  it('real vectors (Ledger app test, py-algorand-sdk) pass, corrupted ones do not', () => {
    for (const a of ['BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCA', 'PNWOET7LLOWMBMLE4KOCELCX6X3D3Q4H2Q4QJASYIEOF7YIPPQBG3YQ5YI', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ']) {
      expect(isAlgoAddress(a)).toBe(true);
    }
    for (const a of ['BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCB', 'bx63zw4o5pwwfdh3j33qeb5yn7in5xokpduq5dcz232edy4dwn3xkuqrca', 'BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRC', 'rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4H', '']) {
      expect(isAlgoAddress(a)).toBe(false);
    }
    // The Ledger app's account-123 public key gives its address.
    const pk = new Uint8Array('0dfdbcdb8eebed628cfb4ef70207b86fd0deddca78e90e8c59d6f441e383b377'.match(/../g)!.map((b) => parseInt(b, 16)));
    expect(algoAddressOf(pk)).toBe('BX63ZW4O5PWWFDH3J33QEB5YN7IN5XOKPDUQ5DCZ232EDY4DWN3XKUQRCA');
  });
});

describe('Algorand in the app', () => {
  it('is a full chain: ALGO asset, CoinGecko id, AlgoNode hosts in the outgoing list', () => {
    expect(ALGO).toMatchObject({ family: 'algo', kind: 'native', symbol: 'ALGO', decimals: 6, chainKey: 'algorand', coingeckoId: 'algorand' });
    expect(nativeAssetId(algorandChain('mainnet'))).toBe('algo');
    expect(assetsFor('mainnet').some((a) => a.id === 'algo')).toBe(true);
    expect(outgoingHosts('testnet').map((h) => h.host)).toEqual(expect.arrayContaining(['testnet-api.algonode.cloud', 'testnet-idx.algonode.cloud']));
    expect(outgoingHosts('mainnet').map((h) => h.host)).toEqual(expect.arrayContaining(['mainnet-api.algonode.cloud', 'mainnet-idx.algonode.cloud']));
  });

  it('vault account, minimum balance, spendable = balance − minimum', async () => {
    expect(isAlgoAddress(accounts.algo.address)).toBe(true);
    expect(accounts.algo.path).toBe("m/44'/283'/0'/0/0");
    expect(await call('algo_address')).toBe(accounts.algo.address);
    const algo = createAdapters(accounts).algo!;
    const me = await algo.account();
    expect(me).toMatchObject({ exists: true, balance: '42500000', minBalance: '200000', spendable: '42300000', assets: 1, authAddr: null });
    expect(await algo.getBalance()).toEqual([{ assetId: 'algo', amount: 42_500_000n, spendable: 42_300_000n }]);
    expect(await call('algo_backend_info')).toMatchObject({ kind: 'default', label: 'testnet-api.algonode.cloud', indexer: 'testnet-idx.algonode.cloud' });
    const hist = await algo.getHistory();
    expect(hist[0]).toMatchObject({ assetId: 'algo', direction: 'in', amount: 42_500_000n, status: 'confirmed', note: 'Merci pour le dîner' });
  });

  it('hardware-wallet accounts have no Algorand adapter', () => {
    const { algo: _a, ...hw } = accounts;
    expect(createAdapters(hw, undefined, undefined, { accountId: 'hw-1', device: 'ledger' }).algo).toBeNull();
  });

  it('send with a note: Rust-shaped summary, native dialog, broadcast, confirmation', async () => {
    const algo = createAdapters(accounts).algo!;
    const u = await algo.buildTx({ asset: ALGO, to: mock.algo.friend, amount: 1_500_000n, fee: { family: 'algo' }, memo: 'Loyer' });
    expect(u.summary).toMatchObject({ receiver: mock.algo.friend, amount: '1500000', fee: '1000', genesisId: 'testnet-v1.0', noteText: 'Loyer', noteLen: 5, requiresExtraConfirmation: true });
    expect(u.summary.lastValid - u.summary.firstValid).toBe(200);
    expect(u.maxFee).toBe(1000n);
    const signed = await algo.signTx(u, PASSWORD);
    expect(dialogs[0]).toContain('Confirmer le paiement Algorand');
    expect(dialogs[0]).toContain('Note (texte libre, publique à jamais) : « Loyer »');
    expect(dialogs[0]).toContain('Réseau : testnet-v1.0 (genesis SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=)');
    expect(dialogs).toHaveLength(2);
    const txid = await algo.broadcast(signed);
    expect(txid).toMatch(/^[A-Z2-7]{52}$/i);
    expect((await algo.txStatus(txid)).confirmed).toBe(false);
    mock.advance(5_000);
    expect((await algo.txStatus(txid)).confirmed).toBe(true);
    expect((await algo.account()).balance).toBe(String(42_500_000 - 1_500_000 - 1_000));
    expect(await err(algo.broadcast(signed))).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('minimum balance rules: a new account needs ≥ 0.1 ALGO, spendable caps the amount, MAX keeps the minimum', async () => {
    const algo = createAdapters(accounts).algo!;
    const dest = await algo.destinationInfo(mock.algo.empty);
    expect(dest).toMatchObject({ exists: false, balance: '0', minBalance: '100000' });
    expect((await err(algo.buildTx({ asset: ALGO, to: mock.algo.empty, amount: 99_999n, fee: { family: 'algo' } }))).message).toContain('au moins 0,1 ALGO');
    expect((await algo.buildTx({ asset: ALGO, to: mock.algo.empty, amount: 100_000n, fee: { family: 'algo' } })).context.destination.exists).toBe(false);
    expect((await err(algo.buildTx({ asset: ALGO, to: mock.algo.friend, amount: 42_299_001n, fee: { family: 'algo' } }))).message).toContain('Solde disponible insuffisant');
    const max = await algo.buildTx({ asset: ALGO, to: mock.algo.friend, amount: 0n, fee: { family: 'algo' }, max: true });
    expect(max.amount).toBe(42_300_000n - 1_000n);
  });

  it('refusals of the decoder: close-remainder-to, rekey, another network, another sender, rekeyed account', async () => {
    const algo = createAdapters(accounts).algo!;
    const u = await algo.buildTx({ asset: ALGO, to: mock.algo.friend, amount: 200_000n, fee: { family: 'algo' } });
    const p = unhex(u.blob);
    for (const [patch, needle] of [
      [{ close: mock.algo.friend }, 'close-remainder-to'],
      [{ rekey: mock.algo.friend }, 'rekey'],
      [{ genesisId: 'mainnet-v1.0' }, 'réseau inattendu'],
      [{ sender: mock.algo.friend }, 'expéditeur'],
    ] as const) {
      expect((await err(call('algo_sign_tx', { blob: hex({ ...p, ...patch }), password: PASSWORD }))).message).toContain(needle);
    }
    expect(dialogs).toHaveLength(0);
    mock.algo.accounts.get(accounts.algo.address)!.authAddr = mock.algo.friend;
    expect((await err(algo.buildTx({ asset: ALGO, to: mock.algo.friend, amount: 200_000n, fee: { family: 'algo' } }))).message).toContain('rekeyé');
  });

  it('a Rust answer that does not match the request is refused by the adapter', async () => {
    const algo = createAdapters(accounts).algo!;
    expect((await err(algo.buildTx({ asset: ALGO, to: accounts.algo.address, amount: 1n, fee: { family: 'algo' } }))).message).toContain('soi-même');
    expect((await err(algo.buildTx({ asset: ALGO, to: 'PNWOET7LLOWMBMLE4KOCELCX6X3D3Q4H2Q4QJASYIEOF7YIPPQBG3YQ5YJ', amount: 1n, fee: { family: 'algo' } }))).message).toContain('Adresse Algorand invalide');
    expect((await err(algo.buildTx({ asset: ALGO, to: mock.algo.friend, amount: 1n, fee: { family: 'algo' }, memo: 'x'.repeat(1025) }))).message).toContain('1024');
  });
});
