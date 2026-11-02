// SPDX-License-Identifier: GPL-3.0-or-later
//
// AptosAdapter against a fake Rust backend. Addresses: the aptos-ts-sdk test wallet
// (« shoot island … », m/44'/637'/0'/0'/0' = 0x07968dab…) and a real mainnet recipient.

import { describe, expect, it } from 'vitest';
import { aptosAddressProblem, AptosAdapter, aptosChain, isAptosAddress, findLookalike, type AptosAccountInfo, type AptosBackend, type AptosTxSummary } from '../src';

const ME = '0x07968dab936c1bad187c60ce4082f307d030d780e91e694ae03aef16aba73f30';
const OTHER = '0x726c91e2852985c2a8c16f32a64c131bd2a0fd1e0aa985a1e0e6002407506ac0';

const acc = (over: Partial<AptosAccountInfo> = {}): AptosAccountInfo => ({ address: ME, balance: '500000000', sequenceNumber: '7', authenticationKey: ME, keyMatches: true, ...over });

function summary(over: Partial<AptosTxSummary> = {}): AptosTxSummary {
  return {
    sender: ME, recipient: OTHER, function: '0x1::aptos_account::transfer', amount: '150000000', sequenceNumber: '7', maxGasAmount: '200', gasUnitPrice: '100', maxFee: '20000',
    expirationTimestampSecs: 1_900_000_600, chainId: 2, warnings: [], requiresExtraConfirmation: false, ...over,
  };
}

const ctx = { account: acc(), recipientNew: false, gasUsed: '11', ledgerTime: 1_900_000_000 };

function backend(over: Partial<AptosBackend> = {}): AptosBackend & { submitted: string[]; built: string[] } {
  const submitted: string[] = [];
  const built: string[] = [];
  return {
    submitted,
    built,
    account: async (a) => acc({ address: a }),
    txs: async () => [
      { version: '10', hash: `0x${'aa'.repeat(32)}`, time: 1_793_508_154_000, direction: 'out', amount: '150000000', fee: '1100', counterparty: OTHER, success: true, function: '0x1::aptos_account::transfer', sentByUs: true },
      { version: '9', hash: null, time: 1_793_508_000_000, direction: 'in', amount: '500000000', fee: '0', counterparty: null, success: true, function: '0x1::aptos_account::transfer', sentByUs: false },
      { version: '8', hash: null, time: 1_793_507_000_000, direction: 'in', amount: '0', fee: '0', counterparty: null, success: true, function: '0x1::aptos_account::transfer', sentByUs: false },
      { version: '7', hash: null, time: 1_793_506_000_000, direction: 'out', amount: '5', fee: '0', counterparty: null, success: true, function: '0xdead::drain::run', sentByUs: false },
    ],
    build: async (to, amount) => {
      built.push(amount);
      return { raw: 'ab', summary: summary({ recipient: to, amount }), context: ctx };
    },
    sign: async () => ({ signed: 'abcd', hash: `0x${'cd'.repeat(32)}`, summary: summary(), context: ctx }),
    broadcast: async (signed) => {
      submitted.push(signed);
      return `0x${'cd'.repeat(32)}`;
    },
    txStatus: async () => ({ committed: true, success: true, vmStatus: 'Executed successfully' }),
    ...over,
  };
}

const APT = { id: 'apt', chainKey: 'aptos', family: 'apt' as const, kind: 'native' as const, symbol: 'APT', name: 'Aptos', decimals: 8, coingeckoId: 'aptos', color: '#000', glyph: 'A' };
const make = (b: AptosBackend) => new AptosAdapter({ chain: aptosChain('testnet'), address: ME, backend: b });

describe('AptosAdapter (testnet)', () => {
  it('accepts only the full 0x + 64 hex form, like Rust', () => {
    expect(isAptosAddress(ME)).toBe(true);
    expect(isAptosAddress(ME.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(isAptosAddress('0x1')).toBe(false);
    expect(isAptosAddress(ME.replace('0x0', '0x'))).toBe(false);
    expect(isAptosAddress(ME.slice(2))).toBe(false);
    expect(aptosAddressProblem('0x1')).toMatch(/Forme courte/i);
    expect(aptosAddressProblem('kyro.apt')).toMatch(/ANS/i);
    expect(aptosAddressProblem(`${ME}00`)).toMatch(/trop longue/i);
    expect(aptosAddressProblem(ME)).toBeNull();
    expect(() => new AptosAdapter({ chain: aptosChain('testnet'), address: '0x1' })).toThrow();
    expect(aptosChain('mainnet')).toMatchObject({ chainId: 1, nativeDecimals: 8, coingeckoId: 'aptos' });
    expect(aptosChain('testnet').chainId).toBe(2);
  });

  it('balance, fee hint, and a build checked against the request', async () => {
    const b = backend();
    const a = make(b);
    expect(await a.getBalance()).toEqual([{ assetId: 'apt', amount: 500_000_000n }]);
    expect((await a.estimateFees()).options.normal.params).toEqual({ family: 'apt' });
    const u = await a.buildTx({ asset: APT, to: OTHER.toUpperCase().replace('0X', '0x'), amount: 150_000_000n, fee: { family: 'apt' } });
    expect(u).toMatchObject({ family: 'apt', recipient: OTHER, amount: 150_000_000n, maxFee: 20_000n, estimatedFee: 1_100n });
    await expect(a.buildTx({ asset: APT, to: ME, amount: 1n, fee: { family: 'apt' } })).rejects.toThrow(/soi-même/i);
    await expect(a.buildTx({ asset: APT, to: '0x1', amount: 1n, fee: { family: 'apt' } })).rejects.toThrow(/Forme courte/i);
  });

  it('refuses anything Rust built that was not asked', async () => {
    for (const bad of [{ recipient: ME }, { amount: '1' }, { function: '0x1::coin::transfer' }, { chainId: 1 }, { requiresExtraConfirmation: true }, { sender: OTHER }]) {
      const a = make(backend({ build: async (to, amount) => ({ raw: 'ab', summary: summary({ recipient: to, amount, ...bad }), context: ctx }) }));
      await expect(a.buildTx({ asset: APT, to: OTHER, amount: 150_000_000n, fee: { family: 'apt' } })).rejects.toThrow(/ne correspond pas/i);
    }
  });

  it('max = balance − maximum fee (the network reserves it up front)', async () => {
    const b = backend();
    const u = await make(b).buildTx({ asset: APT, to: OTHER, amount: 0n, fee: { family: 'apt' }, max: true });
    expect(b.built).toEqual([String(500_000_000 - 1_000_000), String(500_000_000 - 20_000)]);
    expect(u.amount).toBe(499_980_000n);
  });

  it('sign then broadcast: the hash must be the one Rust computed', async () => {
    const b = backend();
    const a = make(b);
    const u = await a.buildTx({ asset: APT, to: OTHER, amount: 150_000_000n, fee: { family: 'apt' } });
    const s = await a.signTx(u, 'pw');
    expect(await a.broadcast(s)).toBe(`0x${'cd'.repeat(32)}`);
    expect(b.submitted).toEqual(['abcd']);
    const liar = make(backend({ broadcast: async () => `0x${'ee'.repeat(32)}` }));
    await expect(liar.broadcast(s)).rejects.toThrow(/inattendu/i);
    const badHash = make(backend({ sign: async () => ({ signed: 'abcd', hash: 'nope', summary: summary(), context: ctx }) }));
    await expect(badHash.signTx(u, 'pw')).rejects.toThrow(/Hash/i);
  });

  it('history: fee only on our sends, poisoning lures flagged', async () => {
    const h = await make(backend()).getHistory();
    expect(h[0]).toMatchObject({ id: `0x${'aa'.repeat(32)}`, direction: 'out', amount: 150_000_000n, fee: 1_100n, counterparty: OTHER, status: 'confirmed', kind: 'transfer' });
    expect(h[1]).toMatchObject({ direction: 'in', amount: 500_000_000n, id: 'aptos-v9' });
    expect(h[1]!.fee).toBeUndefined();
    expect(h[2]!.suspect).toBe('zero');
    expect(h[3]).toMatchObject({ suspect: 'notSigned', kind: 'contract' });
  });

  it('look-alikes are compared as lowercase hex (no checksum on Aptos)', () => {
    const lure = `${OTHER.slice(0, 10)}${'0'.repeat(48)}${OTHER.slice(-8)}`;
    expect(findLookalike(lure, [{ address: OTHER, source: 'sent' }], 'apt')?.known.address).toBe(OTHER);
    expect(findLookalike(OTHER.toUpperCase().replace('0X', '0x'), [{ address: OTHER, source: 'sent' }], 'apt')).toBeNull();
  });
});
