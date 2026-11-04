// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupLocal } from '@kyro/shared';
import { applyLocal, collectLocal, planLocal } from './backup';
import { getAlertSettings, saveAlertSettings, type PriceAlert } from './alerts';
import { getContacts, getFavorites, saveContacts, setFavorites, type Contact } from './storage';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const LOOKALIKE = `0x1111${'0'.repeat(32)}1111`;

const contact = (over: Partial<Contact> = {}): Contact => ({ id: 'c1', name: 'Alice', address: A, family: 'evm', sends: 2, ...over });
const rule = (over: Partial<PriceAlert> = {}): PriceAlert => ({ id: 'r1', coinId: 'bitcoin', symbol: 'BTC', direction: 'above', level: 100, currency: 'USD', armed: false, ...over });
const local = (over: Partial<BackupLocal> = {}): BackupLocal => ({ contacts: [], favorites: [], alerts: { received: false, prices: [] }, ...over });
const valid = () => true;

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
});

describe('what goes in', () => {
  it('takes the address book, the favorites and the alerts, without local ids or states', () => {
    saveContacts([contact()]);
    setFavorites(['bitcoin']);
    saveAlertSettings({ received: true, prices: [rule()] });
    expect(collectLocal()).toEqual({
      contacts: [{ name: 'Alice', address: A, family: 'evm', sends: 2 }],
      favorites: ['bitcoin'],
      alerts: { received: true, prices: [{ coinId: 'bitcoin', symbol: 'BTC', direction: 'above', level: 100, currency: 'USD' }] },
    });
  });

  it('cleans what Rust would refuse rather than failing the export', () => {
    saveContacts([contact({ name: 'A‮b\n' }), contact({ id: 'c2', address: 'has space' }), contact({ id: 'c3', name: '​' })]);
    setFavorites(['ok-coin', '../bad']);
    const out = collectLocal();
    expect(out.contacts.map((c) => c.name)).toEqual(['Ab']);
    expect(out.favorites).toEqual(['ok-coin']);
  });
});

describe('merging', () => {
  it('adds what is new', () => {
    const plan = planLocal(local({ contacts: [{ name: 'Bob', address: B, family: 'evm', sends: 1 }], favorites: ['bitcoin'], alerts: { received: true, prices: [rule()] } }), valid);
    applyLocal(plan, { add: true, replaceNames: false }, 5);
    expect(getContacts().map((c) => [c.name, c.sends])).toEqual([['Bob', 1]]);
    expect(getFavorites()).toEqual(['bitcoin']);
    expect(getAlertSettings().received).toBe(true);
    expect(getAlertSettings().prices[0]).toMatchObject({ id: '5-b0', armed: true, coinId: 'bitcoin' });
  });

  it('never renames without being asked', () => {
    saveContacts([contact()]);
    const plan = planLocal(local({ contacts: [{ name: 'Alicia', address: A.toUpperCase().replace('0X', '0x'), family: 'evm', sends: 9 }] }), valid);
    expect(plan.addContacts).toEqual([]);
    expect(plan.renameContacts).toEqual([{ id: 'c1', address: A, current: 'Alice', backup: 'Alicia' }]);
    applyLocal(plan, { add: true, replaceNames: false });
    expect(getContacts()[0]?.name).toBe('Alice');
    applyLocal(plan, { add: true, replaceNames: true });
    expect(getContacts()[0]).toMatchObject({ id: 'c1', name: 'Alicia', sends: 2 });
  });

  it('changes nothing when nothing is ticked', () => {
    saveContacts([contact()]);
    const plan = planLocal(local({ contacts: [{ name: 'Bob', address: B, family: 'evm', sends: 0 }], favorites: ['x'], alerts: { received: true, prices: [rule()] } }), valid);
    applyLocal(plan, { add: false, replaceNames: false });
    expect(getContacts()).toHaveLength(1);
    expect(getFavorites()).toEqual([]);
    expect(getAlertSettings()).toEqual({ received: false, prices: [] });
  });

  it('importing twice adds nothing the second time', () => {
    const backup = local({ contacts: [{ name: 'Bob', address: B, family: 'evm', sends: 0 }], favorites: ['bitcoin'], alerts: { received: true, prices: [rule()] } });
    applyLocal(planLocal(backup, valid), { add: true, replaceNames: false });
    expect(planLocal(backup, valid)).toEqual({ addContacts: [], renameContacts: [], invalidContacts: 0, lookalikeContacts: 0, addFavorites: [], addAlerts: [], turnOnReceived: false });
  });

  it('leaves out invalid addresses and unknown networks', () => {
    const plan = planLocal(local({ contacts: [{ name: 'Bad', address: 'nope', family: 'evm', sends: 0 }, { name: 'Odd', address: A, family: 'abc', sends: 0 }] }), (_, a) => a !== 'nope');
    expect(plan.addContacts).toEqual([]);
    expect(plan.invalidContacts).toBe(2);
  });

  it('never lets a lookalike into the address book, which Send trusts', () => {
    saveContacts([contact()]);
    const plan = planLocal(local({ contacts: [{ name: 'Fake', address: LOOKALIKE, family: 'evm', sends: 0 }] }), valid);
    expect(plan.addContacts).toEqual([]);
    expect(plan.lookalikeContacts).toBe(1);
  });

  it('a lookalike inside the backup itself is caught too', () => {
    const plan = planLocal(local({ contacts: [{ name: 'One', address: A, family: 'evm', sends: 0 }, { name: 'Two', address: LOOKALIKE, family: 'evm', sends: 0 }] }), valid);
    expect(plan.addContacts.map((c) => c.name)).toEqual(['One']);
    expect(plan.lookalikeContacts).toBe(1);
  });

  it('keeps within the alert limit', () => {
    saveAlertSettings({ received: false, prices: Array.from({ length: 49 }, (_, i) => rule({ id: `r${i}`, level: i + 1 })) });
    const prices = [200, 201].map((level) => ({ coinId: 'bitcoin', symbol: 'BTC', direction: 'above' as const, level, currency: 'USD' }));
    expect(planLocal(local({ alerts: { received: false, prices } }), valid).addAlerts).toHaveLength(1);
  });
});
