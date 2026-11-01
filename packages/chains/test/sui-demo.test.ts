// Sui end to end against the demo backend: typed sui_* commands, accounts_get, coins vs address
// balance, the full-address rule, gas budget, « tout le solde », history rows, execution follow-up.
import { beforeEach, describe, expect, it } from 'vitest';
import { call, IpcError, setBackend, type Accounts, type SuiHistoryEntry } from '@kyro/shared';
import { createMockBackend, suiAddressOf, type MockBackend } from '@kyro/shared/mock';
import { assetsFor, createAdapters, findAsset, isSuiAddress, outgoingHosts, suiAddressProblem, suiHistoryItem, SuiAdapter, suiChain, WATCH_ONLY_CHAINS, type SuiBackend } from '../src';

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

const SUI = findAsset('testnet', 'sui')!;
const stranger = suiAddressOf(new Uint8Array(32).fill(7));

beforeEach(async () => {
  dialogs = [];
  mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: PASSWORD, unlocked: true } });
  setBackend(mock.invoke);
  accounts = await call('accounts_get');
});

describe('Sui in the app', () => {
  it('is a full chain: SUI asset (9 decimals, coingecko « sui »), GraphQL hosts listed', () => {
    expect(WATCH_ONLY_CHAINS.map((w) => w.key)).not.toContain('sui');
    expect(SUI).toMatchObject({ family: 'sui', kind: 'native', symbol: 'SUI', decimals: 9, chainKey: 'sui', coingeckoId: 'sui' });
    expect(suiChain('testnet').name).toBe('Sui testnet');
    expect(assetsFor('mainnet').some((a) => a.id === 'sui')).toBe(true);
    expect(outgoingHosts('testnet').map((h) => h.host)).toContain('graphql.testnet.sui.io');
    expect(outgoingHosts('mainnet').map((h) => h.host)).toContain('graphql.mainnet.sui.io');
  });

  it('addresses: 0x + 64 hex only, short forms and SuiNS refused (UI and Rust rules)', async () => {
    expect(isSuiAddress(accounts.sui.address)).toBe(true);
    expect(accounts.sui.path).toBe("m/44'/784'/0'/0'/0'");
    expect(await call('sui_address', {})).toBe(accounts.sui.address);
    expect(await call('sui_address', { account: 3 })).not.toBe(accounts.sui.address);
    expect(suiAddressProblem('0x2')).toMatch(/Forme courte/);
    expect(suiAddressProblem('kyro.sui')).toMatch(/SuiNS/);
    expect(suiAddressProblem('abc')).toMatch(/0x suivi de 64/);
    expect(suiAddressProblem(stranger)).toBeNull();
    expect((await err(call('sui_balance', { address: '0x2' }))).message).toMatch(/forme courte refusée/);
    expect((await err(call('sui_build_tx', { to: 'kyro.sui', amount: '1' }))).message).toMatch(/SuiNS/);
  });

  it('balance: total, spendable coins, backend info', async () => {
    const sui = createAdapters(accounts).sui!;
    expect(sui.getAddress()).toBe(accounts.sui.address);
    expect(await sui.getBalance()).toEqual([{ assetId: 'sui', amount: 15_500_000_000n, spendable: 15_500_000_000n }]);
    expect(await call('sui_backend_info')).toMatchObject({ kind: 'default', label: 'graphql.testnet.sui.io', network: 'testnet' });
  });

  it('hardware-wallet accounts have no Sui adapter', () => {
    const { sui: _s, xrp: _x, tron: _t, ltc: _l, doge: _d, ...hw } = accounts;
    const ad = createAdapters(hw, undefined, undefined, { accountId: 'hw-1', device: 'ledger' });
    expect(ad.sui).toBeNull();
    expect(ad.all.some((a) => a.family === 'sui')).toBe(false);
  });

  it('send an amount: decoded summary, French dialog, broadcast, indexed later', async () => {
    const sui = createAdapters(accounts).sui!;
    const u = await sui.buildTx({ asset: SUI, to: stranger.toUpperCase().replace('0X', '0x'), amount: 1_500_000_000n, fee: { family: 'sui' } });
    expect(u.summary).toMatchObject({ recipient: stranger, amount: '1500000000', coinType: '0x2::sui::SUI', gasPrice: '1000', gasBudget: '2997880', warnings: [] });
    expect(u.maxFee).toBe(2_997_880n);
    expect(u.recipient).toBe(stranger);
    const s = await sui.signTx(u, PASSWORD);
    expect(dialogs[0]).toContain(`À : ${stranger}\n`);
    expect(dialogs[0]).toContain('Montant : 1,5 SUI (1500000000 MIST)');
    expect(dialogs[0]).toContain('Jeton : SUI (0x2::sui::SUI)');
    expect(dialogs[0]).toContain('Budget de gaz maximal : 0,00299788 SUI (2997880 MIST) · prix du gaz : 1000 MIST/unité (référence 1000)');
    expect(dialogs[0]).toContain('Valable jusqu\'à la fin de l\'époque n° 1271');
    // Each gas coin: object id and version decoded from the bytes, balance read live.
    expect(u.context.gasCoinBalances).toHaveLength(u.summary.gasCoins.length);
    for (const [i, g] of u.summary.gasCoins.entries()) {
      expect(g.objectId).toMatch(/^0x[0-9a-f]{64}$/);
      expect(dialogs[0]).toContain(`  • ${g.objectId} (version ${g.version}) : `);
      expect(u.context.gasCoinBalances[i]).toMatch(/^\d+$/);
    }
    const digest = await sui.broadcast(s);
    expect(digest).toBe(u.summary.digest);
    expect((await sui.txStatus(digest)).found).toBe(false);
    mock.advance(5_000);
    expect(await sui.txStatus(digest)).toMatchObject({ found: true, success: true });
    const fee = 1_000_000n + 1_976_000n - 978_120n;
    expect((await sui.getBalance())[0]?.amount).toBe(15_500_000_000n - 1_500_000_000n - fee);
    const [last] = await sui.getHistory();
    expect(last).toMatchObject({ id: digest, direction: 'out', amount: 1_500_000_000n, fee, counterparty: stranger, status: 'confirmed', assetId: 'sui' });
  });

  it('« tout le solde »: sendAll warning, reinforced dialog, nothing left', async () => {
    const sui = createAdapters(accounts).sui!;
    const u = await sui.buildTx({ asset: SUI, to: stranger, amount: 0n, fee: { family: 'sui' }, max: true });
    expect(u.all).toBe(true);
    expect(u.summary.amount).toBeNull();
    expect(u.summary.warnings).toEqual([{ kind: 'sendAll' }]);
    expect(u.amount).toBe(15_500_000_000n - (1_000_000n + 1_976_000n - 978_120n));
    await sui.broadcast(await sui.signTx(u, PASSWORD));
    expect(dialogs[0]).toContain('TOUT LE SOLDE');
    expect(dialogs[1]).toContain('Attention : transfert à vérifier');
    expect((await sui.getBalance())[0]?.amount).toBe(0n);
  });

  it('refusals: more than the coins, a changed gas coin, account without SUI', async () => {
    const sui = createAdapters(accounts).sui!;
    const e = await err(sui.buildTx({ asset: SUI, to: stranger, amount: 20_000_000_000n, fee: { family: 'sui' } }));
    expect(e.message).toMatch(/solde insuffisant/);
    const u = await sui.buildTx({ asset: SUI, to: stranger, amount: 1n, fee: { family: 'sui' } });
    // Spend first with another transfer: the gas coin of `u` has a new version.
    await sui.broadcast(await sui.signTx(await sui.buildTx({ asset: SUI, to: stranger, amount: 2n, fee: { family: 'sui' } }), PASSWORD));
    expect((await err(sui.signTx(u, PASSWORD))).message).toMatch(/pièces de gaz ont changé/);
    expect((await err(call('sui_build_tx', { to: stranger, amount: '1', account: 2 }))).message).toMatch(/aucun SUI/);
  });

  it('adapter refuses what does not match the request', async () => {
    const backend: SuiBackend = {
      balance: () => Promise.resolve({ address: accounts.sui.address, total: '1', coin: '1', addressBalance: '0' }),
      txs: () => Promise.resolve([]),
      build: (to, amount) =>
        call('sui_build_tx', { to, amount: (amount ?? 0n) + 1n + '' }).then((b) => b),
      sign: () => Promise.reject(new Error('no')),
      broadcast: () => Promise.reject(new Error('no')),
      txStatus: () => Promise.reject(new Error('no')),
    };
    const a = new SuiAdapter({ chain: suiChain('testnet'), address: accounts.sui.address, backend });
    expect((await err(a.buildTx({ asset: SUI, to: stranger, amount: 5n, fee: { family: 'sui' } }))).message).toMatch(/ne correspond pas/);
  });

  it('history rows: incoming, outgoing with fee, zero incoming flagged, other coins noted', () => {
    const me = accounts.sui.address;
    const base: SuiHistoryEntry = { digest: 'D', timestamp: '2026-11-01T00:31:29.700Z', checkpoint: 1, success: true, sender: stranger, change: '3000000000', fee: null, counterparty: stranger, otherCoins: false };
    expect(suiHistoryItem(base, me)).toMatchObject({ direction: 'in', amount: 3_000_000_000n, counterparty: stranger, time: Date.parse(base.timestamp!) });
    expect(suiHistoryItem({ ...base, sender: me, change: '-1002000000', fee: '2000000' }, me)).toMatchObject({ direction: 'out', amount: 1_000_000_000n, fee: 2_000_000n });
    expect(suiHistoryItem({ ...base, sender: me, change: '-2000000', fee: '2000000', counterparty: null }, me)).toMatchObject({ direction: 'self', amount: 0n });
    expect(suiHistoryItem({ ...base, change: '0' }, me).suspect).toBe('zero');
    expect(suiHistoryItem({ ...base, otherCoins: true, success: false }, me)).toMatchObject({ status: 'failed', note: expect.stringMatching(/autres jetons|D’autres jetons/) });
  });
});
