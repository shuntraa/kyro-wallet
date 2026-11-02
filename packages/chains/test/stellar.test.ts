// Stellar end to end against the demo backend (typed stellar_* commands, accounts_get, reserve,
// memo-required, CreateAccount) and the adapter's own checks of what Rust built.
import { beforeEach, describe, expect, it } from 'vitest';
import { call, setBackend, stellarAddressOfKey, type Accounts, type StellarContext, type StellarTxSummary } from '@kyro/shared';
import { createMockBackend, type MockBackend } from '@kyro/shared/mock';
import {
  addressParts,
  allChains,
  assetsFor,
  createAdapters,
  findAsset,
  isLookalike,
  outgoingHosts,
  parseStellarMemo,
  sameMemo,
  StellarAdapter,
  stellarAddressProblem,
  stellarChain,
  WATCH_ONLY_CHAINS,
  xlmToStroops,
  type StellarBackend,
} from '../src';

const PASSWORD = 'correct horse battery';
let accounts: Accounts;
let mock: MockBackend;
let dialogs: string[];
const XLM = findAsset('testnet', 'xlm')!;

beforeEach(async () => {
  dialogs = [];
  mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: PASSWORD, unlocked: true } });
  setBackend(mock.invoke);
  accounts = await call('accounts_get');
});

describe('Stellar in the app', () => {
  it('is a full chain: XLM asset (7 decimals, CoinGecko « stellar »), Horizon in the outgoing list', () => {
    expect(WATCH_ONLY_CHAINS.map((w) => w.key)).not.toContain('stellar');
    expect(XLM).toMatchObject({ family: 'xlm', kind: 'native', symbol: 'XLM', decimals: 7, chainKey: 'stellar', coingeckoId: 'stellar' });
    expect(assetsFor('mainnet').some((a) => a.id === 'xlm')).toBe(true);
    expect(allChains('testnet').find((c) => c.key === 'stellar')?.name).toBe('Stellar testnet');
    expect(outgoingHosts('testnet').map((h) => h.host)).toContain('horizon-testnet.stellar.org');
    expect(outgoingHosts('mainnet').map((h) => h.host)).toContain('horizon.stellar.org');
    expect(outgoingHosts('mainnet').map((h) => h.host)).not.toContain('friendbot.stellar.org');
  });

  it('balance and spendable (balance − reserve), hardware wallets have no Stellar adapter', async () => {
    const xlm = createAdapters(accounts).stellar!;
    expect(xlm.getAddress()).toBe(accounts.stellar.address);
    expect(await xlm.getBalance()).toEqual([{ assetId: 'xlm', amount: 1_250_000_000n, spendable: 1_235_000_000n }]);
    const { stellar: _s, xrp: _x, tron: _t, ltc: _l, doge: _d, cardano: _c, ...hw } = accounts;
    expect(createAdapters(hw, undefined, undefined, { accountId: 'hw-1', device: 'ledger' }).stellar).toBeNull();
  });

  it('memo required → refused; with a memo: built, signed (dialog), broadcast, in the history', async () => {
    const xlm = createAdapters(accounts).stellar!;
    const st = mock.stellar;
    const dest = await xlm.destinationInfo(st.exchange);
    expect(dest.memoRequired).toBe(true);
    await expect(xlm.buildTx({ asset: XLM, to: st.exchange, amount: 25_000_000n, fee: { family: 'xlm' } })).rejects.toThrow(/exige un mémo/i);
    const memo = parseStellarMemo('id', ' 804539585 ');
    const u = await xlm.buildTx({ asset: XLM, to: st.exchange, amount: 25_000_000n, fee: { family: 'xlm' }, ...(memo ? { stellarMemo: memo } : {}) });
    expect(u).toMatchObject({ family: 'xlm', amount: 25_000_000n, createsAccount: false, maxFee: 100n, memo: { kind: 'id', value: '804539585' } });
    const signed = await xlm.signTx(u, PASSWORD);
    expect(dialogs.at(-1)).toContain('MÉMO (identifiant) : 804539585');
    expect(await xlm.broadcast(signed)).toBe(signed.hash);
    const h = await xlm.getHistory();
    expect(h[0]).toMatchObject({ direction: 'out', amount: 25_000_000n, fee: 100n, counterparty: st.exchange, status: 'confirmed', note: 'mémo 804539585' });
    expect(h.at(-1)).toMatchObject({ direction: 'in', note: 'création de ton compte · mémo « bienvenue »' });
  });

  it('unfunded destination: CreateAccount (≥ 1 XLM); max = spendable − fee', async () => {
    const xlm = createAdapters(accounts).stellar!;
    const fresh = stellarAddressOfKey(new Uint8Array(32).fill(9));
    await expect(xlm.buildPayment({ to: fresh, stroops: 5_000_000n })).rejects.toThrow(/au moins 1 XLM/i);
    const u = await xlm.buildPayment({ to: fresh, stroops: 10_000_000n });
    expect(u.createsAccount).toBe(true);
    expect(u.summary.operation).toEqual({ kind: 'createAccount', destination: fresh, startingBalance: '10000000' });
    const max = await xlm.buildTx({ asset: XLM, to: mock.stellar.friend, amount: 0n, max: true, fee: { family: 'xlm' } });
    expect(max.amount).toBe(1_235_000_000n - 100n);
  });
});

describe('Stellar adapter checks', () => {
  it('addresses, amounts and memos', () => {
    expect(stellarAddressProblem('MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ')).toMatch(/M…/i);
    expect(stellarAddressProblem('SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN')).toMatch(/CLÉ SECRÈTE/i);
    expect(stellarAddressProblem('GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ')).toBeNull();
    expect(xlmToStroops('12,5')).toBe(125_000_000n);
    expect(xlmToStroops('0.0000001')).toBe(1n);
    expect(() => xlmToStroops('0.00000001')).toThrow();
    expect(() => xlmToStroops('-1')).toThrow();
    expect(parseStellarMemo('text', '')).toBeUndefined();
    expect(parseStellarMemo('id', '')).toBeUndefined();
    expect(() => parseStellarMemo('text', 'é'.repeat(15))).toThrow(/28 octets/i);
    expect(() => parseStellarMemo('id', '18446744073709551616')).toThrow();
    expect(parseStellarMemo('hash', 'AB'.repeat(32))).toEqual({ kind: 'hash', value: 'ab'.repeat(32) });
    expect(sameMemo(undefined, { kind: 'none' })).toBe(true);
    expect(sameMemo({ kind: 'id', value: '1' }, { kind: 'id', id: '2' })).toBe(false);
    expect(sameMemo({ kind: 'text', value: 'a' }, { kind: 'text', text: 'a', hex: '61' })).toBe(true);
    // Poisoning: G is a fixed prefix; same first / last 4 characters of the body → look-alike.
    const a = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
    expect(addressParts(a, 'xlm')).toMatchObject({ prefix: 'G', caseInsensitive: false });
    expect(isLookalike(a, `GA7QY${'A'.repeat(47)}VSGZ`, 'xlm')).toBe(true);
    expect(isLookalike(a, `GB7QY${'A'.repeat(47)}VSGZ`, 'xlm')).toBe(false);
  });

  it('refuses what Rust built when it differs from the request (memo, amount, destination, network)', async () => {
    const me = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
    const to = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
    let summary: StellarTxSummary;
    const base = (): StellarTxSummary => ({ network: 'testnet', source: me, fee: '100', sequence: '2', minTime: 0, maxTime: 1, memo: { kind: 'id', id: '7' }, operation: { kind: 'payment', destination: to, asset: { kind: 'native' }, amount: '10' }, warnings: [], requiresExtraConfirmation: false });
    const backend: StellarBackend = {
      account: () => Promise.reject(new Error('unused')),
      txs: () => Promise.resolve([]),
      build: () => Promise.resolve({ envelope: 'AAAA', summary, context: {} as StellarContext }),
      sign: () => Promise.reject(new Error('unused')),
      broadcast: () => Promise.reject(new Error('unused')),
      txStatus: () => Promise.reject(new Error('unused')),
    };
    const xlm = new StellarAdapter({ chain: stellarChain('testnet'), address: me, backend });
    const ask = { to, stroops: 10n, memo: { kind: 'id' as const, value: '7' } };
    summary = base();
    await expect(xlm.buildPayment(ask)).resolves.toMatchObject({ amount: 10n });
    for (const bad of [
      { ...base(), memo: { kind: 'none' as const } },
      { ...base(), memo: { kind: 'id' as const, id: '8' } },
      { ...base(), operation: { kind: 'payment' as const, destination: to, asset: { kind: 'native' as const }, amount: '11' } },
      { ...base(), operation: { kind: 'payment' as const, destination: me, asset: { kind: 'native' as const }, amount: '10' } },
      { ...base(), operation: { kind: 'payment' as const, destination: to, asset: { kind: 'credit' as const, code: 'XLM', issuer: me }, amount: '10' } },
      { ...base(), network: 'mainnet' as const },
      { ...base(), requiresExtraConfirmation: true },
    ]) {
      summary = bad;
      await expect(xlm.buildPayment(ask)).rejects.toThrow(/ne correspond pas/i);
    }
  });
});
