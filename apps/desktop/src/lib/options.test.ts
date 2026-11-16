import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLang } from '@kyro/shared';
import { fmtCrypto, fmtSats, getBtcUnit, inSats, NNBSP, parseSatsInput, sanitizeSatsInput, setBtcUnit } from './format';
import { hiddenAsSmall, withoutSmall } from './hideSmall';
import { blockedByContactsOnly, isFirstSend, sentBefore } from './recipientCheck';
import { applyNotes, cleanNote, collectNotes, getNote, MAX_NOTE, planNotes, setNote } from './txNotes';

describe('Bitcoin in sats', () => {
  afterEach(() => {
    setBtcUnit('btc');
    setLang('fr');
  });

  it('writes BTC amounts as whole, grouped sats only when asked', () => {
    setLang('en');
    expect(fmtCrypto(50_000n, 8, 'BTC')).toBe(`0.0005${NNBSP}BTC`);
    setBtcUnit('sats');
    expect(getBtcUnit()).toBe('sats');
    expect(fmtCrypto(50_000n, 8, 'BTC')).toBe(`50,000${NNBSP}sats`);
    expect(fmtCrypto(2_100_000_000_000_000n, 8, 'BTC')).toBe(`2,100,000,000,000,000${NNBSP}sats`);
    expect(fmtCrypto(1n, 8, 'BTC')).toBe(`1${NNBSP}sat`);
    expect(fmtCrypto(-1234n, 8, 'BTC')).toBe(`−1,234${NNBSP}sats`);
    // Not Bitcoin, or no unit asked: unchanged.
    expect(fmtCrypto(50_000n, 8, 'WBTC')).toBe(`0.0005${NNBSP}WBTC`);
    expect(fmtCrypto(50_000n, 8)).toBe('0.0005');
    expect(fmtCrypto(100_000_000n, 8, 'LTC')).toBe(`1${NNBSP}LTC`);
    setLang('fr');
    expect(fmtSats(1_234_567n)).toBe(`1${NNBSP}234${NNBSP}567${NNBSP}sats`);
  });

  it('knows which asset is typed in sats', () => {
    expect(inSats({ symbol: 'BTC', decimals: 8 })).toBe(false);
    setBtcUnit('sats');
    expect(inSats({ symbol: 'BTC', decimals: 8 })).toBe(true);
    expect(inSats({ symbol: 'ETH', decimals: 18 })).toBe(false);
    expect(inSats(undefined)).toBe(false);
    setBtcUnit(undefined);
    expect(getBtcUnit()).toBe('btc');
  });

  it('parses typed sats exactly, never through a float', () => {
    expect(sanitizeSatsInput('1 234,56')).toBe('123456');
    expect(sanitizeSatsInput('000120')).toBe('120');
    expect(sanitizeSatsInput('0')).toBe('0');
    expect(sanitizeSatsInput('9'.repeat(20))).toHaveLength(16);
    expect(parseSatsInput('2100000000000000')).toBe(2_100_000_000_000_000n);
    expect(parseSatsInput('9007199254740993')).toBe(9_007_199_254_740_993n);
    expect(parseSatsInput('')).toBeNull();
    expect(parseSatsInput('1.5')).toBeNull();
    expect(parseSatsInput('-3')).toBeNull();
  });
});

describe('hide small balances', () => {
  const h = (amount: bigint, value: number | null) => ({ amount, value });
  it('follows the threshold, keeps unpriced holdings, shows all while searching', () => {
    expect(hiddenAsSmall(h(0n, 0), 'off')).toBe(false);
    expect(hiddenAsSmall(h(0n, 0), undefined)).toBe(false);
    expect(hiddenAsSmall(h(0n, null), 'zero')).toBe(true);
    expect(hiddenAsSmall(h(5n, 0.0001), 'zero')).toBe(false);
    expect(hiddenAsSmall(h(5n, 0.99), 'under1')).toBe(true);
    expect(hiddenAsSmall(h(5n, 1), 'under1')).toBe(false);
    expect(hiddenAsSmall(h(5n, 9.5), 'under10')).toBe(true);
    expect(hiddenAsSmall(h(5n, null), 'under10')).toBe(false);
    const rows = [h(0n, 0), h(5n, 3), h(5n, 50)];
    expect(withoutSmall(rows, 'under10')).toEqual([h(5n, 50)]);
    expect(withoutSmall(rows, 'under10', 'eth')).toEqual(rows);
  });
});

describe('recipient rules', () => {
  const evm = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
  it('recognises an earlier recipient whatever the case', () => {
    expect(sentBefore(evm.toLowerCase(), 'evm', [evm])).toBe(true);
    expect(sentBefore(evm, 'evm', [])).toBe(false);
    expect(sentBefore('', 'evm', [evm])).toBe(false);
  });
  it('warns on a first send to a stranger, blocks strangers when contacts only', () => {
    const stranger = { contact: false, own: false, sentBefore: false };
    expect(isFirstSend(stranger)).toBe(true);
    expect(isFirstSend({ ...stranger, sentBefore: true })).toBe(false);
    expect(isFirstSend({ ...stranger, contact: true })).toBe(false);
    expect(blockedByContactsOnly(true, stranger)).toBe(true);
    expect(blockedByContactsOnly(true, { ...stranger, sentBefore: true })).toBe(true);
    expect(blockedByContactsOnly(true, { ...stranger, contact: true })).toBe(false);
    expect(blockedByContactsOnly(true, { ...stranger, own: true })).toBe(false);
    expect(blockedByContactsOnly(false, stranger)).toBe(false);
    expect(blockedByContactsOnly(undefined, stranger)).toBe(false);
  });
});

describe('private transaction notes', () => {
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
  it('cleans, stores, removes and goes through the backup without replacing', () => {
    expect(cleanNote('  loyer‮\n de  mars ')).toBe('loyer de mars');
    expect([...cleanNote('x'.repeat(300))]).toHaveLength(MAX_NOTE);
    setNote('mainnet', 'bitcoin', 'abc', 'Loyer');
    expect(getNote('mainnet', 'bitcoin', 'abc')).toBe('Loyer');
    expect(getNote('testnet', 'bitcoin', 'abc')).toBeUndefined();
    expect(collectNotes()).toEqual([{ network: 'mainnet', chain: 'bitcoin', id: 'abc', text: 'Loyer' }]);
    const plan = planNotes([
      { network: 'mainnet', chain: 'bitcoin', id: 'abc', text: 'Autre' },
      { network: 'testnet', chain: 'ethereum', id: '0x1', text: 'Test' },
      { network: 'testnet', chain: 'ethereum', id: '0x1', text: 'Twice' },
    ]);
    expect(plan).toEqual([{ network: 'testnet', chain: 'ethereum', id: '0x1', text: 'Test' }]);
    applyNotes(plan);
    expect(getNote('testnet', 'ethereum', '0x1')).toBe('Test');
    expect(getNote('mainnet', 'bitcoin', 'abc')).toBe('Loyer');
    setNote('mainnet', 'bitcoin', 'abc', '   ');
    expect(getNote('mainnet', 'bitcoin', 'abc')).toBeUndefined();
    expect(planNotes(undefined)).toEqual([]);
  });
});
