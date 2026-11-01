// Hedera end to end against the demo backend: typed hbar_* commands, accounts_get, the EVM
// address (alias) of m/44'/3030'/0'/0/a, our account 0.0.x, recipient refusals, the memo, the max
// fee, one copy per node, the native dialog text and the consensus follow-up.
import { beforeEach, describe, expect, it } from 'vitest';
import { call, IpcError, setBackend, type Accounts } from '@kyro/shared';
import { createMockBackend, hbarChecksum, parseHbarRecipient, type MockBackend } from '@kyro/shared/mock';
import { assetsFor, createAdapters, findAsset, hbarMemoError, isHbarRecipient, normalizeHbarRecipient, outgoingHosts, addressParts, isLookalike } from '../src';

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

const HBAR = findAsset('testnet', 'hbar')!;

beforeEach(async () => {
  dialogs = [];
  mock = createMockBackend({ network: 'testnet', torEnabled: false, confirm: (t) => (dialogs.push(t), true), preset: { password: PASSWORD, unlocked: true } });
  setBackend(mock.invoke);
  accounts = await call('accounts_get');
});

describe('Hedera helpers', () => {
  it('HIP-15 checksums (0.0.123-vfmkw mainnet, -esxsf testnet) and recipients', () => {
    expect(hbarChecksum('mainnet', 123)).toBe('vfmkw');
    expect(hbarChecksum('testnet', 123)).toBe('esxsf');
    expect(parseHbarRecipient('0.0.123-esxsf', 'testnet')).toEqual({ to: '0.0.123', isEvm: false, num: 123 });
    expect(() => parseHbarRecipient('0.0.123-vfmkw', 'testnet')).toThrow(/somme de contrôle/);
    expect(parseHbarRecipient('0x0000000000000000000000000000000000000320', 'mainnet')).toMatchObject({ to: '0.0.800', isEvm: false });
    expect(() => parseHbarRecipient('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96046', 'mainnet')).toThrow(/EIP-55/);
    expect(isHbarRecipient('0.0.98')).toBe(true);
    expect(isHbarRecipient('0.0.98-abcde')).toBe(true);
    expect(isHbarRecipient('0.0.098')).toBe(false);
    expect(isHbarRecipient('1.0.98')).toBe(false);
    expect(isHbarRecipient('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(true);
    expect(normalizeHbarRecipient('0.0.123-esxsf')).toBe('0.0.123');
    expect(normalizeHbarRecipient('0x0000000000000000000000000000000000000320')).toBe('0.0.800');
    expect(normalizeHbarRecipient('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe('0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
  });

  it('memo rules = Rust’s: ≤ 100 bytes, no control / invisible / bidi character', () => {
    expect(hbarMemoError('104857')).toBeNull();
    expect(hbarMemoError('é'.repeat(50))).toBeNull();
    expect(hbarMemoError('é'.repeat(51))).toMatch(/100 octets/);
    expect(hbarMemoError('a\nb')).toMatch(/contrôle/);
    expect(hbarMemoError('a‮b')).toMatch(/contrôle/);
  });

  it('poisoning: 0x compared lowercase, 0.0.x by number (checksum dropped)', () => {
    expect(addressParts('0.0.4815162-abcde', 'hbar')).toMatchObject({ prefix: '0.0.', body: '4815162' });
    expect(addressParts('0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'hbar')).toMatchObject({ prefix: '0x', body: 'd8da6bf26964af9d7eed9e03e53415d37aa96045' });
    expect(isLookalike('0xd8da0000000000000000000000000000000a6045', '0xd8da6bf26964af9d7eed9e03e53415d37aa96045', 'hbar')).toBe(true);
  });
});

describe('Hedera in the app', () => {
  it('is a full chain: HBAR asset (8 decimals, hedera-hashgraph price), mirror node and node proxies listed', () => {
    expect(HBAR).toMatchObject({ family: 'hbar', kind: 'native', symbol: 'HBAR', decimals: 8, chainKey: 'hedera', coingeckoId: 'hedera-hashgraph' });
    expect(assetsFor('mainnet').some((a) => a.id === 'hbar')).toBe(true);
    expect(outgoingHosts('testnet').map((h) => h.host)).toContain('testnet.mirrornode.hedera.com');
    expect(outgoingHosts('mainnet').map((h) => h.host)).toContain('mainnet-public.mirrornode.hedera.com');
    expect(outgoingHosts('mainnet').some((h) => h.host.includes('node00.swirldslabs.com'))).toBe(true);
  });

  it('vault account: EVM address of m/44’/3030’/0’/0/0, account 0.0.x with checksum, balance', async () => {
    expect(accounts.hbar.path).toBe("m/44'/3030'/0'/0/0");
    expect(await call('hbar_address', {})).toBe(accounts.hbar.address);
    const hbar = createAdapters(accounts).hbar!;
    expect(hbar.getAddress()).toBe(accounts.hbar.address);
    const me = await hbar.account();
    expect(me).toMatchObject({ exists: true, accountId: `0.0.${mock.hbar.num}`, address: accounts.hbar.address, foundBy: 'alias' });
    expect(me.accountIdChecksum).toBe(`0.0.${mock.hbar.num}-${hbarChecksum('testnet', mock.hbar.num)}`);
    expect(await hbar.getBalance()).toEqual([{ assetId: 'hbar', amount: 4_250_000_000n }]);
    expect(await call('hbar_backend_info')).toMatchObject({ label: 'testnet.mirrornode.hedera.com', network: 'testnet' });
    const h = await hbar.getHistory();
    expect(h[0]).toMatchObject({ direction: 'in', amount: 2_500_000_000n, counterparty: '0.0.1006', status: 'confirmed' });
    expect(h[1]?.note).toBe('Mémo : « merci »');
  });

  it('hardware-wallet accounts have no Hedera adapter (HW_UNSUPPORTED)', () => {
    const { hbar: _h, xrp: _x, tron: _t, ltc: _l, doge: _d, cardano: _c, ...hw } = accounts;
    const ad = createAdapters(hw, undefined, undefined, { accountId: 'hw-1', device: 'ledger' });
    expect(ad.hbar).toBeNull();
  });

  it('refuses unknown, deleted or signature-requiring recipients before building', async () => {
    const hbar = createAdapters(accounts).hbar!;
    expect((await err(hbar.buildTransfer({ to: '0.0.424242', amount: 100n }))).message).toMatch(/n’existe pas/);
    expect((await err(hbar.buildTransfer({ to: mock.hbar.guarded, amount: 100n }))).message).toMatch(/signature du destinataire/);
    expect((await err(hbar.buildTransfer({ to: `0.0.${mock.hbar.num}`, amount: 100n }))).message).toMatch(/soi-même/);
    expect((await err(hbar.buildTransfer({ to: accounts.hbar.address, amount: 100n }))).message).toMatch(/soi-même/);
    expect((await err(hbar.buildTransfer({ to: mock.hbar.friend, amount: 4_250_000_000n }))).message).toMatch(/solde insuffisant/);
    expect((await err(hbar.buildTransfer({ to: mock.hbar.friend, amount: 1n, memo: 'a\u0000b' }))).message).toMatch(/contrôle/);
  });

  it('sends with a memo: one body per node, dialog with the memo framed after the amount, consensus follow-up', async () => {
    const hbar = createAdapters(accounts).hbar!;
    const u = await hbar.buildTransfer({ to: mock.hbar.exchange, amount: 150_000_000n, memo: '104857' });
    expect(u.bodies).toHaveLength(3);
    expect(u.summary).toMatchObject({ to: '0.0.1006', amount: '150000000', memo: '104857', nodes: ['0.0.3', '0.0.4', '0.0.5'], validDuration: 180 });
    // 0.5 ¢ at 7.18 ¢ / HBAR.
    expect(u.maxFee).toBe(6_961_687n);
    const signed = await hbar.signTx(u, PASSWORD);
    const d = dialogs.at(-1)!;
    expect(d).toContain('Envoi Hedera (testnet)');
    expect(d).toContain('À : 0.0.1006');
    expect(d).toContain('Montant : 1,5 HBAR (150000000 tinybars)');
    expect(d).toContain('MÉMO (public à jamais) : « 104857 »');
    expect(d.indexOf('Montant')).toBeLessThan(d.indexOf('MÉMO'));
    const id = await hbar.broadcast(signed);
    expect(id).toBe(u.summary.transactionId);
    expect(await hbar.txStatus(id)).toEqual({ found: false, result: '' });
    mock.advance(5_000);
    expect(await hbar.txStatus(id)).toEqual({ found: true, result: 'SUCCESS' });
    // Broadcasting the same copies again is a duplicate, not a second transfer.
    expect(await hbar.broadcast(signed)).toBe(id);
    expect((await hbar.getBalance())[0]?.amount).toBe(4_250_000_000n - 150_000_000n - 83_000n);
  });

  it('to an EVM address without account: the transfer creates it (higher max fee), AUCUN MÉMO shown', async () => {
    const hbar = createAdapters(accounts).hbar!;
    const to = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    const info = await hbar.recipientInfo(to);
    expect(info).toMatchObject({ exists: false, isEvm: true, to });
    const u = await hbar.buildTransfer({ to, amount: 100_000_000n });
    expect(u.context.createsAccount).toBe(true);
    expect(u.maxFee).toBe(139_233_750n);
    await hbar.signTx(u, PASSWORD);
    expect(dialogs.at(-1)).toContain('AUCUN MÉMO');
    expect(dialogs.at(-1)).toContain('ce transfert le crée');
  });

  it('max: balance minus the max fee', async () => {
    const hbar = createAdapters(accounts).hbar!;
    const u = await hbar.buildTx({ asset: HBAR, to: mock.hbar.friend, amount: 0n, fee: { family: 'hbar' }, max: true });
    expect(u.amount).toBe(4_250_000_000n - 6_961_687n);
  });

  it('wrong password, refused dialog, extra accounts: nothing is signed', async () => {
    const hbar = createAdapters(accounts).hbar!;
    const u = await hbar.buildTransfer({ to: mock.hbar.friend, amount: 1_000n });
    expect((await err(hbar.signTx(u, 'nope'))).code).toBe('WRONG_PASSWORD');
    expect((await err(call('hbar_build_tx', { to: mock.hbar.friend, amount: '1000', account: 1 }))).message).toMatch(/Mode démo/);
  });
});
