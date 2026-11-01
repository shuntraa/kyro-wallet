// TON end to end against the demo backend: typed ton_* commands, accounts_get, the adapter's
// checks of what Rust built (recipient, amount, comment), bounce off for an inactive recipient,
// whole balance, refusals in Rust's words, follow-up, history, poisoning by account.
import { beforeEach, describe, expect, it } from 'vitest';
import { call, IpcError, setBackend, tonFriendly, type Accounts } from '@kyro/shared';
import { createMockBackend, type MockBackend } from '@kyro/shared/mock';
import {
  assetsFor,
  createAdapters,
  findAsset,
  isLookalike,
  matchesCoinQuery,
  outgoingHosts,
  sameAddress,
  tonCommentProblem,
  tonRecipientProblem,
  TonAdapter,
  tonChain,
  WATCH_ONLY_CHAINS,
  type TonBackend,
} from '../src';

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

const TON = findAsset('testnet', 'ton')!;
const fee = { family: 'ton' as const };

beforeEach(async () => {
  dialogs = [];
  mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: PASSWORD, unlocked: true } });
  setBackend(mock.invoke);
  accounts = await call('accounts_get');
});

describe('TON in the app', () => {
  it('is a full chain: Gram asset (GRAM, ex-Toncoin, 9 decimals, CoinGecko the-open-network), TON Center in the outgoing list', () => {
    expect(WATCH_ONLY_CHAINS.map((w) => w.key)).not.toContain('ton');
    expect(TON).toMatchObject({ family: 'ton', kind: 'native', symbol: 'GRAM', name: 'Gram', decimals: 9, chainKey: 'ton', coingeckoId: 'the-open-network' });
    expect(assetsFor('mainnet').some((a) => a.id === 'ton')).toBe(true);
    expect(outgoingHosts('testnet').map((h) => h.host)).toContain('testnet.toncenter.com');
    expect(outgoingHosts('mainnet').map((h) => h.host)).toContain('toncenter.com');
  });

  it('is found by its new and former names (gram, ton, toncoin), network still TON', () => {
    const gram = assetsFor('mainnet').find((a) => a.id === 'ton')!;
    for (const q of ['gram', 'ton', 'toncoin', 'gr']) expect(matchesCoinQuery(q, gram), q).toBe(true);
    expect(matchesCoinQuery('bitcoin', gram)).toBe(false);
    expect(tonChain('mainnet')).toMatchObject({ name: 'TON', label: 'TON', nativeSymbol: 'GRAM', nativeName: 'Gram' });
    // A market list cached before the rename still shows Toncoin: found anyway.
    expect(matchesCoinQuery('gram', { name: 'Toncoin', symbol: 'TON', coingeckoId: 'the-open-network' })).toBe(true);
  });

  it('vault account: non-bounceable testnet address, balance, seqno', async () => {
    expect(accounts.ton.address.startsWith('0Q')).toBe(true);
    expect(accounts.ton.path).toBe("m/44'/607'/0'");
    expect(await call('ton_address', {})).toBe(accounts.ton.address);
    const ton = createAdapters(accounts).ton!;
    expect(await ton.getBalance()).toEqual([{ assetId: 'ton', amount: 42_750_000_000n }]);
    expect(await ton.account()).toMatchObject({ status: 'active', seqno: 12, walletType: 'wallet v4 r2' });
    expect(await call('ton_backend_info')).toMatchObject({ network: 'testnet', label: 'testnet.toncenter.com' });
  });

  it('hardware-wallet accounts have no TON adapter', () => {
    const { ton: _t, xrp: _x, tron: _r, ltc: _l, doge: _d, cardano: _c, ...hw } = accounts;
    expect(createAdapters(hw, undefined, undefined, { accountId: 'hw-1', device: 'ledger' }).ton).toBeNull();
  });

  it('sends with a comment: Rust decodes it, the dialog frames it, both address forms shown', async () => {
    const ton = createAdapters(accounts).ton!;
    const u = await ton.buildTx({ asset: TON, to: mock.ton.friend, amount: 1_500_000_000n, fee, memo: '7239104' });
    expect(u.summary).toMatchObject({ comment: '7239104', amount: '1500000000', bounce: false, sendAll: false, seqno: 12, deploysWallet: false });
    expect(u.maxFee).toBe(3_400_000n);
    const signed = await ton.signTx(u, PASSWORD);
    expect(dialogs[0]).toContain('COMMENTAIRE : « 7239104 »');
    expect(dialogs[0]).toContain('même compte que');
    const id = await ton.broadcast(signed);
    expect(id).toBe(signed.normalizedHash);
    expect(await ton.txStatus(id)).toMatchObject({ found: false });
    mock.advance(6_000);
    expect(await ton.txStatus(id)).toMatchObject({ found: true, success: true });
    const h = await ton.getHistory();
    expect(h[0]).toMatchObject({ direction: 'out', amount: 1_500_000_000n, status: 'confirmed', note: 'Commentaire : 7239104' });
    // Same seqno again: refused (stale).
    expect((await err(ton.signTx(u, PASSWORD))).message).toMatch(/seqno/);
  });

  it('bounceable address of an inactive account: sent without bounce, said in the dialog', async () => {
    const ton = createAdapters(accounts).ton!;
    const freshBounceable = tonFriendly(0, '11'.repeat(32), true, true);
    const u = await ton.buildTx({ asset: TON, to: freshBounceable, amount: 1_000_000_000n, fee });
    expect(u.summary.bounce).toBe(false);
    expect(u.context.destination.status).toBe('uninit');
    await ton.signTx(u, PASSWORD);
    expect(dialogs[0]).toContain('AUCUN COMMENTAIRE');
    expect(dialogs[0]).toContain('pas encore actif');
  });

  it('MAX = whole balance (mode 130), amount shown as balance − fee', async () => {
    const ton = createAdapters(accounts).ton!;
    const u = await ton.buildTx({ asset: TON, to: mock.ton.friend, amount: 0n, fee, max: true });
    expect(u.sendAll).toBe(true);
    expect(u.summary).toMatchObject({ sendAll: true, amount: '0' });
    expect(u.amount).toBe(42_750_000_000n - 3_400_000n);
  });

  it('refusals: Rust’s and the adapter’s', async () => {
    const ton = createAdapters(accounts).ton!;
    // Raw form, mainnet-only check, masterchain, comment limits.
    expect(tonRecipientProblem(`0:${'ab'.repeat(32)}`, 'testnet')).toMatch(/brute/);
    expect(tonRecipientProblem(tonFriendly(0, 'ab'.repeat(32), false, true), 'mainnet')).toMatch(/testnet/);
    expect(tonRecipientProblem(tonFriendly(-1, 'ab'.repeat(32), true, false), 'mainnet')).toMatch(/masterchain/);
    expect(tonCommentProblem('x'.repeat(124))).toMatch(/trop long/);
    expect(tonCommentProblem('é'.repeat(61))).toBeNull();
    expect(tonCommentProblem('a‮b')).toMatch(/invisibles/);
    expect((await err(ton.buildTx({ asset: TON, to: accounts.ton.address, amount: 1n, fee }))).message).toMatch(/soi-même/);
    // More than the balance (amount + fee).
    expect((await err(ton.buildTx({ asset: TON, to: mock.ton.friend, amount: 42_750_000_000n, fee }))).message).toMatch(/solde GRAM insuffisant/);
    // Rust refuses a raw address on its own too.
    expect((await err(call('ton_account', { address: `0:${'ab'.repeat(32)}` }))).code).toBe('INVALID_INPUT');
    // Wrong password: nothing signed.
    const u = await ton.buildTx({ asset: TON, to: mock.ton.friend, amount: 1n, fee });
    expect((await err(ton.signTx(u, 'wrong password!'))).code).toBe('WRONG_PASSWORD');
  });

  it('adapter refuses a transfer Rust did not build as asked', async () => {
    const real = createAdapters(accounts).ton!;
    const lying: TonBackend = {
      account: (a) => call('ton_account', { address: a }),
      txs: (a) => call('ton_txs', { address: a }),
      build: async (to, amount, comment, sendAll) => {
        const b = await call('ton_build_tx', { to, amount, ...(comment ? { comment } : {}), ...(sendAll ? { sendAll } : {}) });
        return { ...b, summary: { ...b.summary, comment: null } };
      },
      sign: (boc, password) => call('ton_sign_tx', { boc, password }),
      broadcast: (boc) => call('ton_broadcast', { boc }),
      txStatus: (hash) => call('ton_tx_status', { hash }),
    };
    const ton = new TonAdapter({ chain: tonChain('testnet'), address: real.getAddress(), backend: lying });
    expect((await err(ton.buildTx({ asset: TON, to: mock.ton.friend, amount: 5n, fee, memo: 'memo' }))).message).toMatch(/ne correspond pas/);
  });

  it('poisoning: EQ… and UQ… of one account are the same address, look-alikes still caught', () => {
    const a = tonFriendly(0, 'ab'.repeat(32), true, false);
    const b = tonFriendly(0, 'ab'.repeat(32), false, false);
    expect(sameAddress(a, b, 'ton')).toBe(true);
    expect(isLookalike(a, b, 'ton')).toBe(false);
    const fake = `${a.slice(0, 6)}${'A'.repeat(38)}${a.slice(-4)}`;
    expect(isLookalike(fake, a, 'ton')).toBe(true);
  });
});
