// SPDX-License-Identifier: GPL-3.0-or-later
//
// XrpAdapter against a fake Rust backend. Addresses: Trezor firmware fixtures (`all ×12`,
// m/44'/144'/0'/0/0 = rNaqKtKr…, /0/1 = rBKz5MC2…).

import { describe, expect, it } from 'vitest';
import { isXrpAddress, parseDestinationTag, XrpAdapter, xrpChain, type XrpAccountInfo, type XrpBackend, type XrpTxSummary } from '../src';

const ME = 'rNaqKtKrMSwpwZSzRckPf7S96DkimjkF4H';
const OTHER = 'rBKz5MC2iXdoS3XgnNSYmF69K1Yo4NS3Ws';

const acc = (over: Partial<XrpAccountInfo> = {}): XrpAccountInfo => ({
  address: ME, exists: true, balance: '100000000', sequence: 7, ownerCount: 0, flags: 0, requireDestTag: false, disallowXrp: false, reserve: '1000000', spendable: '99000000', ...over,
});

function summary(over: Partial<XrpTxSummary> = {}): XrpTxSummary {
  return {
    account: ME, destination: OTHER, destinationTag: null, amount: { kind: 'xrp', drops: '5000000' }, fee: '12', sequence: 7, lastLedgerSequence: 100,
    flags: 0x80000000, sendMax: null, sourceTag: null, invoiceId: null, memos: [], warnings: [], requiresExtraConfirmation: false, ...over,
  };
}

const ctx = { account: acc(), destination: acc({ address: OTHER }), reserveBase: '1000000', reserveInc: '200000' };

function backend(over: Partial<XrpBackend> = {}): XrpBackend & { submitted: string[] } {
  const submitted: string[] = [];
  return {
    submitted,
    account: async (a) => acc({ address: a }),
    lines: async () => [{ currency: 'USD', issuer: OTHER, balance: '12.5', limit: '1000' }],
    txs: async () => [
      { hash: 'AA'.repeat(32), from: ME, to: OTHER, destinationTag: 12345, amount: { kind: 'xrp', drops: '5000000' }, fee: '10', ledger: 5, time: 1_793_356_140_000, result: 'tesSUCCESS' },
      { hash: 'BB'.repeat(32), from: OTHER, to: ME, destinationTag: null, amount: { kind: 'xrp', drops: '100000000' }, fee: '12', ledger: 4, time: 1_793_356_100_000, result: 'tesSUCCESS' },
    ],
    build: async (to, amount, destinationTag) => ({ blob: '1200', summary: summary({ destination: to, amount: { kind: 'xrp', drops: amount }, destinationTag: destinationTag ?? null }), context: ctx }),
    sign: async () => ({ blob: '1200AB', hash: 'CD'.repeat(32), summary: summary(), context: ctx }),
    broadcast: async (blob) => {
      submitted.push(blob);
      return 'CD'.repeat(32);
    },
    txStatus: async () => ({ validated: true, result: 'tesSUCCESS' }),
    ...over,
  };
}

describe('XrpAdapter (testnet)', () => {
  it('validates classic addresses and destination tags', () => {
    expect(isXrpAddress(ME)).toBe(true);
    expect(isXrpAddress('XVLhHMPHU98es4dbozjVtdWzVrDjtV18pX8yuPT7y4xaEHi')).toBe(false);
    expect(isXrpAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(false);
    expect(isXrpAddress('r0OIl')).toBe(false);
    expect(parseDestinationTag('')).toBeUndefined();
    expect(parseDestinationTag(' 12345 ')).toBe(12345);
    expect(parseDestinationTag('4294967295')).toBe(4294967295);
    expect(() => parseDestinationTag('4294967296')).toThrow(/trop grand/i);
    expect(() => parseDestinationTag('12a')).toThrow(/invalide/i);
    expect(() => parseDestinationTag('-1')).toThrow();
  });

  it('balance with spendable (balance − reserve), trust lines apart', async () => {
    const a = new XrpAdapter({ chain: xrpChain('testnet'), address: ME, backend: backend() });
    expect(await a.getBalance()).toEqual([{ assetId: 'xrp', amount: 100_000_000n, spendable: 99_000_000n }]);
    expect((await a.trustLines())[0]?.currency).toBe('USD');
    expect((await a.destinationInfo(OTHER)).requireDestTag).toBe(false);
  });

  it('builds through Rust and checks destination, amount and destination tag', async () => {
    const a = new XrpAdapter({ chain: xrpChain('testnet'), address: ME, backend: backend() });
    const u = await a.buildPayment({ to: OTHER, amount: '5000000', destinationTag: 12345 });
    expect(u.summary.destinationTag).toBe(12345);
    const v = await a.buildPayment({ to: OTHER, amount: '5000000' });
    expect(v.summary.destinationTag).toBeNull();
    await expect(a.buildPayment({ to: ME, amount: '1' })).rejects.toThrow(/soi-même/i);
    await expect(a.buildPayment({ to: OTHER, amount: '1.5' })).rejects.toThrow(/drops/i);
    for (const over of [
      { build: async () => ({ blob: '', summary: summary({ destinationTag: 999 }), context: ctx }) }, // tag changed
      { build: async () => ({ blob: '', summary: summary({ amount: { kind: 'xrp', drops: '1' } }), context: ctx }) },
      { build: async () => ({ blob: '', summary: summary({ destination: ME }), context: ctx }) },
      { build: async () => ({ blob: '', summary: summary({ requiresExtraConfirmation: true, warnings: [{ kind: 'memo' }] }), context: ctx }) },
    ] satisfies Partial<XrpBackend>[]) {
      const x = new XrpAdapter({ chain: xrpChain('testnet'), address: ME, backend: backend(over) });
      await expect(x.buildPayment({ to: OTHER, amount: '5000000' })).rejects.toThrow(/ne correspond pas/i);
    }
  });

  it('signs and submits through Rust, hash checked', async () => {
    const b = backend();
    const a = new XrpAdapter({ chain: xrpChain('testnet'), address: ME, backend: b });
    const s = await a.signTx(await a.buildPayment({ to: OTHER, amount: '5000000' }), 'pw');
    expect(await a.broadcast(s)).toBe('CD'.repeat(32));
    expect(b.submitted).toEqual(['1200AB']);
    expect(await a.txStatus(s.hash)).toEqual({ validated: true, result: 'tesSUCCESS' });
    const bad = new XrpAdapter({ chain: xrpChain('testnet'), address: ME, backend: backend({ broadcast: async () => 'EE'.repeat(32) }) });
    await expect(bad.broadcast(s)).rejects.toThrow(/inattendu/i);
  });

  it('maps history', async () => {
    const a = new XrpAdapter({ chain: xrpChain('testnet'), address: ME, backend: backend() });
    const h = await a.getHistory();
    expect(h[0]).toMatchObject({ assetId: 'xrp', direction: 'out', amount: 5_000_000n, fee: 10n, counterparty: OTHER, chainKey: 'xrp', status: 'confirmed' });
    expect(h[1]).toMatchObject({ direction: 'in', amount: 100_000_000n, counterparty: OTHER });
  });
});
