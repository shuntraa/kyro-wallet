// XRP Ledger end to end against the demo backend: typed xrp_* commands, accounts_get, the
// reserve and spendable, the destination-tag rules (lsfRequireDestTag), activation of a new
// account, the strict decoding (X-address, Paths, partial payment), validation follow-up, servers.
import { beforeEach, describe, expect, it } from 'vitest';
import { call, IpcError, setBackend, type Accounts } from '@kyro/shared';
import { createMockBackend, xrpAddressOfId, type MockBackend } from '@kyro/shared/mock';
import { assetsFor, createAdapters, findAsset, isXAddress, isXrpAddress, outgoingHosts, WATCH_ONLY_CHAINS } from '../src';

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

const hex = (o: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(o)), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const fresh = (label: string) => xrpAddressOfId(new TextEncoder().encode(label.padEnd(20, '.')).slice(0, 20));
const XRP = findAsset('testnet', 'xrp')!;

beforeEach(async () => {
  dialogs = [];
  mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: PASSWORD, unlocked: true } });
  setBackend(mock.invoke);
  accounts = await call('accounts_get');
});

describe('XRP Ledger in the app', () => {
  it('is a full chain now: not « Bientôt », XRP asset, rippled hosts in the outgoing list', () => {
    expect(WATCH_ONLY_CHAINS.map((w) => w.key)).not.toContain('xrp');
    expect(XRP).toMatchObject({ family: 'xrp', kind: 'native', symbol: 'XRP', decimals: 6, chainKey: 'xrp' });
    expect(assetsFor('mainnet').some((a) => a.id === 'xrp')).toBe(true);
    expect(outgoingHosts('testnet').map((h) => h.host)).toContain('s.altnet.rippletest.net');
    expect(outgoingHosts('mainnet').map((h) => h.host)).toContain('xrplcluster.com');
    const custom = outgoingHosts('testnet', { bitcoin: {}, evm: {}, solana: {}, litecoin: {}, bitcoincash: {}, dash: {}, dogecoin: {}, tron: {}, cardano: {}, xrp: { testnet: { kind: 'jsonRpc', url: 'https://my-rippled.example:51234/' } } });
    expect(custom.find((h) => h.host === 'my-rippled.example:51234')).toMatchObject({ custom: true });
    expect(custom.map((h) => h.host)).not.toContain('s.altnet.rippletest.net');
  });

  it('vault account (index 0 only), reserve 1 XRP + 0.2 × objects, spendable = balance − reserve', async () => {
    expect(isXrpAddress(accounts.xrp.address)).toBe(true);
    expect(await call('xrp_address', { index: 0 })).toBe(accounts.xrp.address);
    const xrp = createAdapters(accounts).xrp!;
    expect(xrp.getAddress()).toBe(accounts.xrp.address);
    const me = await xrp.account();
    expect(me).toMatchObject({ exists: true, balance: '85000000', ownerCount: 2, reserve: '1400000', spendable: '83600000' });
    expect(await xrp.getBalance()).toEqual([{ assetId: 'xrp', amount: 85_000_000n, spendable: 83_600_000n }]);
    expect((await xrp.trustLines())[0]?.currency).toBe('USD');
    expect(await call('xrp_backend_info')).toMatchObject({ kind: 'default', label: 's.altnet.rippletest.net', network: 'testnet' });
  });

  it('hardware-wallet accounts have no XRP adapter (HW_UNSUPPORTED)', () => {
    const { xrp: _x, tron: _t, ltc: _l, doge: _d, ...hw } = accounts;
    const ad = createAdapters(hw, undefined, undefined, { accountId: 'hw-1', device: 'ledger' });
    expect(ad.xrp).toBeNull();
    expect(ad.all.some((a) => a.family === 'xrp')).toBe(false);
  });

  it('lsfRequireDestTag: refused without a tag, the tag framed in the dialog once given', async () => {
    const xrp = createAdapters(accounts).xrp!;
    const ex = mock.xrp.exchange;
    expect((await xrp.destinationInfo(ex)).requireDestTag).toBe(true);
    const e = await err(xrp.buildTx({ asset: XRP, to: ex, amount: 10_000_000n, fee: { family: 'xrp' } }));
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.message).toMatch(/exige un tag de destination \(lsfRequireDestTag\)/i);
    const u = await xrp.buildTx({ asset: XRP, to: ex, amount: 10_000_000n, fee: { family: 'xrp' }, destinationTag: 104857 });
    expect(u.summary).toMatchObject({ destinationTag: 104857, fee: '12', amount: { kind: 'xrp', drops: '10000000' } });
    expect(u.maxFee).toBe(12n);
    const s = await xrp.signTx(u, PASSWORD);
    expect(dialogs[0]).toContain('TAG DE DESTINATION : 104857');
    expect(dialogs[0]).toContain('réserve bloquée : 1,4 XRP (1 XRP + 0,2 XRP × 2 objet(s)) · disponible : 83,6 XRP');
    expect(await xrp.broadcast(s)).toBe(s.hash);
  });

  it('no tag to a regular account: dialog says « AUCUN TAG DE DESTINATION »', async () => {
    const xrp = createAdapters(accounts).xrp!;
    await xrp.signTx(await xrp.buildTx({ asset: XRP, to: mock.xrp.friend, amount: 1_000_000n, fee: { family: 'xrp' } }), PASSWORD);
    expect(dialogs[0]).toContain('AUCUN TAG DE DESTINATION');
  });

  it('unfunded destination: < 1 XRP refused (tecNO_DST_INSUF_XRP), 1 XRP creates the account', async () => {
    const xrp = createAdapters(accounts).xrp!;
    const to = fresh('kyro-new');
    expect((await xrp.destinationInfo(to)).exists).toBe(false);
    expect((await err(xrp.buildTx({ asset: XRP, to, amount: 500_000n, fee: { family: 'xrp' } }))).message).toMatch(/au moins la réserve de base \(1 XRP\).*tecNO_DST_INSUF_XRP/i);
    const u = await xrp.buildTx({ asset: XRP, to, amount: 1_000_000n, fee: { family: 'xrp' } });
    expect(u.context.destination.exists).toBe(false);
    await xrp.broadcast(await xrp.signTx(u, PASSWORD));
    expect(dialogs[0]).toContain("Ce compte n'existe pas encore : ce paiement le crée");
    expect((await xrp.destinationInfo(to)).exists).toBe(true);
    // An issued currency cannot go to an unfunded account (tecNO_DST).
    expect((await err(xrp.buildPayment({ to: fresh('kyro-new-2'), amount: '1', issued: { currency: 'USD', issuer: mock.xrp.friend } }))).message).toMatch(/tecNO_DST/i);
  });

  it('amount + fee above the spendable part is refused; MAX = spendable − fee', async () => {
    const xrp = createAdapters(accounts).xrp!;
    expect((await err(xrp.buildTx({ asset: XRP, to: mock.xrp.friend, amount: 84_000_000n, fee: { family: 'xrp' } }))).message).toMatch(/solde disponible insuffisant : 83,6 XRP disponibles \(solde − réserve\)/i);
    const max = await xrp.buildTx({ asset: XRP, to: mock.xrp.friend, amount: 0n, fee: { family: 'xrp' }, max: true });
    expect(max.amount).toBe(83_600_000n - 12n);
  });

  it('X-addresses, Paths, DeliverMin and partial payments are refused', async () => {
    const xa = 'XVLhHMPHU98es4dbozjVtdWzVrDjtV18pX8yuPT7y4xaEHi';
    expect(isXAddress(xa)).toBe(true);
    expect(isXrpAddress(xa)).toBe(false);
    expect((await err(call('xrp_account', { address: xa }))).message).toMatch(/les X-addresses ne sont pas prises en charge : demande l'adresse classique r… et le tag de destination/i);
    const base = { account: accounts.xrp.address, destination: mock.xrp.friend, destinationTag: null, amount: { kind: 'xrp', drops: '1000000' }, fee: '12', sequence: 4_812_307, lastLedgerSequence: 99_999_999, flags: 0x80000000 };
    for (const [over, msg] of [
      [{ paths: [[{ currency: 'USD' }]] }, /les chemins \(Paths\) ne sont pas pris en charge/],
      [{ deliverMin: '1' }, /DeliverMin \(paiements partiels\)/],
      [{ flags: 0x80020000 }, /paiements partiels \(tfPartialPayment\) sont refusés/],
      [{ account: mock.xrp.friend }, /l'Account n'est pas l'adresse de ce portefeuille/],
    ] as const) {
      expect((await err(call('xrp_sign_tx', { blob: hex({ ...base, ...over }), password: PASSWORD }))).message).toMatch(msg);
    }
    expect(dialogs).toHaveLength(0);
  });

  it('validation follow-up: pending, then « validée » (tesSUCCESS) or « échouée » (tec*)', async () => {
    const xrp = createAdapters(accounts).xrp!;
    const s = await xrp.signTx(await xrp.buildTx({ asset: XRP, to: mock.xrp.friend, amount: 2_000_000n, fee: { family: 'xrp' } }), PASSWORD);
    const hash = await xrp.broadcast(s);
    expect(await xrp.txStatus(hash)).toEqual({ validated: false, result: '' });
    mock.advance(5_000);
    expect(await xrp.txStatus(hash)).toEqual({ validated: true, result: 'tesSUCCESS' });
    expect((await xrp.getHistory())[0]).toMatchObject({ id: hash, direction: 'out', amount: 2_000_000n, fee: 12n, status: 'confirmed' });
    mock.xrp.failNext = 'tecPATH_DRY';
    const t = await xrp.broadcast(await xrp.signTx(await xrp.buildTx({ asset: XRP, to: mock.xrp.friend, amount: 1_000_000n, fee: { family: 'xrp' } }), PASSWORD));
    mock.advance(5_000);
    expect(await xrp.txStatus(t)).toEqual({ validated: true, result: 'tecPATH_DRY' });
    // Expired payment (LastLedgerSequence passed): rebuild needed.
    const old = await xrp.buildTx({ asset: XRP, to: mock.xrp.friend, amount: 1_000_000n, fee: { family: 'xrp' } });
    mock.advance(120_000);
    expect((await err(xrp.signTx(old, PASSWORD))).message).toMatch(/LastLedgerSequence dépassé/i);
  });

  it('servers: default rippled, wrong network refused, custom rippled saved', async () => {
    expect((await call('server_test', { target: { family: 'xrp', network: 'testnet', server: { kind: 'default' } } })).detected).toMatchObject({ network: 'testnet', chainId: 1 });
    expect((await err(call('server_test', { target: { family: 'xrp', network: 'testnet', server: { kind: 'jsonRpc', url: 'https://wrong-rippled.example/' } } }))).code).toBe('SERVER_WRONG_NETWORK');
    expect((await err(call('server_test', { target: { family: 'xrp', network: 'testnet', server: { kind: 'jsonRpc', url: 'http://rippled.example/' } } }))).code).toBe('SERVER_INVALID');
    const st = await call('settings_get');
    await call('settings_set', { settings: { ...st, servers: { ...st.servers, xrp: { testnet: { kind: 'jsonRpc', url: 'https://my-rippled.example:51234/' } } } } });
    expect(await call('xrp_backend_info')).toMatchObject({ kind: 'jsonRpc', label: 'my-rippled.example' });
    expect((await err(call('settings_set', { settings: { ...st, servers: { ...st.servers, xrp: { testnet: { kind: 'jsonRpc', url: 'https://down-rippled.example/' } } } } }))).code).toBe('SERVER_UNREACHABLE');
  });

  it('config_get: hasTrongridKey follows a saved apiKeys.trongrid (write-only)', async () => {
    expect((await call('config_get')).hasTrongridKey).toBe(false);
    const st = await call('settings_get');
    const { apiKeysSet: _set, ...rest } = st;
    await call('settings_set', { settings: { ...rest, apiKeys: { trongrid: 'k' } } });
    expect((await call('config_get')).hasTrongridKey).toBe(true);
  });
});
