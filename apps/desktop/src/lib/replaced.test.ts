// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseTxId, reconcileReplaced, recordReplacement, type ReplacedTx } from './replaced';
import { getLocalTxs } from './storage';

const item = (id: string, status: string) => ({ id, status });

describe('reconcileReplaced', () => {
  const locals = [
    { id: 'old', replacedBy: 'new' },
    { id: 'new', replaces: 'old' },
  ];

  it('leaves everything alone without a replacement', () => {
    const items = [item('a', 'pending')];
    expect(reconcileReplaced(items, [{ id: 'a' }])).toEqual(items);
  });

  it('hides the replaced transaction while it is pending', () => {
    expect(reconcileReplaced([item('old', 'pending'), item('new', 'pending')], locals)).toEqual([item('new', 'pending')]);
  });

  it('keeps hiding it once the replacement confirmed', () => {
    expect(reconcileReplaced([item('old', 'failed'), item('new', 'confirmed')], locals)).toEqual([item('new', 'confirmed')]);
  });

  it('shows the original if it won, and the replacement as failed', () => {
    expect(reconcileReplaced([item('old', 'confirmed'), item('new', 'pending')], locals)).toEqual([item('old', 'confirmed'), item('new', 'failed')]);
  });

  it('sees through account and log suffixes, and follows a second speed-up', () => {
    expect(baseTxId('0xabc@2')).toBe('0xabc');
    const chain = [{ id: 'a', replacedBy: 'b' }, { id: 'b', replaces: 'a', replacedBy: 'c' }, { id: 'c', replaces: 'b' }];
    expect(reconcileReplaced([item('a@1', 'pending'), item('b', 'pending'), item('c', 'pending')], chain)).toEqual([item('c', 'pending')]);
  });
});

describe('recordReplacement', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) } });
  });
  afterEach(() => vi.unstubAllGlobals());

  const tx: ReplacedTx = { network: 'testnet', id: 'old@1', chainKey: 'bitcoin', assetId: 'btc', kind: 'transfer', direction: 'out', amount: 500n, fee: 10n, counterparty: 'bc1q' };

  it('keeps the payment on a speed-up and links both records', () => {
    recordReplacement(tx, 'new', { cancel: false, fee: 40n, label: 'x' }, 1000);
    const list = getLocalTxs('testnet');
    expect(list.find((t) => t.id === 'old')?.replacedBy).toBe('new');
    expect(list.find((t) => t.id === 'new')).toMatchObject({ replaces: 'old', amount: '500', fee: '40', counterparty: 'bc1q', status: 'pending', time: 1000 });
    expect(list.find((t) => t.id === 'new')?.replacedBy).toBeUndefined();
  });

  it('shows a cancel as a send of nothing to yourself', () => {
    recordReplacement(tx, 'new', { cancel: true, fee: 40n, label: 'Cancelled' }, 1000);
    expect(getLocalTxs('testnet').find((t) => t.id === 'new')).toMatchObject({ direction: 'self', amount: '0', label: 'Cancelled', replaces: 'old' });
  });
});
