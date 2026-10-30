// SPDX-License-Identifier: GPL-3.0-or-later
//
// CardanoAdapter against a fake Rust backend. Addresses: CIP-0019 test vectors (preprod /
// testnet forms) and Trezor's `all ×12` fixtures.

import { describe, expect, it } from 'vitest';
import {
  adaToLovelace,
  cardanoChain,
  CardanoAdapter,
  isByronAddress,
  isCardanoAddress,
  type CardanoBackend,
  type CardanoContext,
  type CardanoTxSummary,
} from '../src';

const ME = 'addr_test1qrv42wjda8r6mpfj40d36znlgfdcqp7jtj03ah8skh6u8wnrqua2vw243tmjfjt0h5wsru6appuz8c0pfd75ur7myyeqnsc9fs';
const OTHER = 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae';
const ENTERPRISE = 'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz';
const POLICY = '95a292ffee938be03e9bae5657982a74e9014eb4960108c9e23a5b39';

const ctx: CardanoContext = {
  account: { address: ME, balance: '10000000', tokens: [], utxoCount: 1, lockedWithTokens: '0' },
  params: { minFeeA: 44, minFeeB: 155381, coinsPerByte: 4310, maxTxSize: 16384 },
  tip: { slot: 1000, blockHeight: 1, epoch: 1 },
  leaving: '2172497',
};

function summary(over: Partial<CardanoTxSummary> = {}): CardanoTxSummary {
  return {
    txId: 'ab'.repeat(32),
    inputs: [`${'cd'.repeat(32)}#0`],
    outputs: [
      { address: OTHER, kind: 'base', isChange: false, lovelace: '2000000', tokens: [], minLovelace: '969750' },
      { address: ME, kind: 'base', isChange: true, lovelace: '7827503', tokens: [], minLovelace: '969750' },
    ],
    fee: '172497',
    ttl: 4600,
    validFrom: null,
    memo: null,
    warnings: [],
    requiresExtraConfirmation: false,
    ...over,
  };
}

function backend(over: Partial<CardanoBackend> = {}): CardanoBackend & { submitted: string[] } {
  const submitted: string[] = [];
  return {
    submitted,
    address: async (index) => ({ address: ME, path: `m/1852'/1815'/0'/0/${index}`, stakeAddress: 'stake_test1…', accountXpub: '00' }),
    account: async (address) => ({ ...ctx.account, address, balance: '12000000', lockedWithTokens: '1189560', tokens: [{ policy: POLICY, name: '74', nameText: 't', quantity: '5', verified: false }] }),
    txs: async () => [
      { hash: 'aa'.repeat(32), time: 1_793_357_604_000, blockHeight: 9, fee: '172497', lovelaceDelta: '-2172497', tokenDeltas: [], memo: 'merci' },
      { hash: 'bb'.repeat(32), time: null, blockHeight: null, fee: '170000', lovelaceDelta: '10000000', tokenDeltas: [], memo: null },
    ],
    build: async (to, lovelace, token, memo) => {
      const s = summary({ memo: memo ? [memo] : null });
      const dest = s.outputs[0]!;
      dest.address = to;
      if (token) {
        dest.tokens = [{ policy: token.policy, name: token.name, nameText: null, quantity: token.quantity, verified: false }];
        dest.minLovelace = '1189560';
        dest.lovelace = lovelace ?? '1189560';
      } else if (lovelace) dest.lovelace = lovelace;
      return { tx: '84a4', summary: s, context: ctx };
    },
    sign: async () => ({ tx: '84a4a1', txId: 'ab'.repeat(32), summary: summary(), context: ctx }),
    broadcast: async (tx) => {
      submitted.push(tx);
      return 'ab'.repeat(32);
    },
    txStatus: async () => ({ confirmations: 2 }),
    ...over,
  };
}

const adapter = (b = backend()) => new CardanoAdapter({ chain: cardanoChain('testnet'), address: ME, backend: b });

describe('CardanoAdapter (preprod)', () => {
  it('recognises Shelley payment addresses only', () => {
    expect(isCardanoAddress(ME, 'testnet')).toBe(true);
    expect(isCardanoAddress(OTHER, 'testnet')).toBe(true);
    expect(isCardanoAddress(ENTERPRISE, 'testnet')).toBe(true);
    expect(isCardanoAddress(OTHER, 'mainnet')).toBe(false);
    expect(isCardanoAddress('addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x', 'mainnet')).toBe(true);
    // Script payment (type 1, 7), pointer (4), reward, Byron: false.
    expect(isCardanoAddress('addr_test1zrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gten0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgsxj90mg', 'testnet')).toBe(false);
    expect(isCardanoAddress('addr_test1wrphkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcl6szpr', 'testnet')).toBe(false);
    expect(isCardanoAddress('addr_test1gz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrdw5vky', 'testnet')).toBe(false);
    expect(isCardanoAddress('stake_test1uqehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gssrtvn', 'testnet')).toBe(false);
    expect(isCardanoAddress(OTHER.toUpperCase(), 'testnet')).toBe(false);
    expect(isByronAddress('Ae2tdPwUPEZCanmBz5g2GEwFqKTKpNJcGYPKfDxoNeKZ8bRHr8366kseiK2')).toBe(true);
    expect(isByronAddress(OTHER)).toBe(false);
  });

  it('parses ADA amounts exactly', () => {
    expect(adaToLovelace('1')).toBe(1_000_000n);
    expect(adaToLovelace('1,5')).toBe(1_500_000n);
    expect(adaToLovelace('0.000001')).toBe(1n);
    expect(() => adaToLovelace('0.0000001')).toThrow(/invalide/);
    expect(() => adaToLovelace('-1')).toThrow();
  });

  it('balance: spendable excludes the ADA tied to tokens', async () => {
    const b = await adapter().getBalance();
    expect(b.ada).toEqual({ amount: 12_000_000n, spendable: 10_810_440n });
    expect(b.tokens[0]?.policy).toBe(POLICY);
  });

  it('builds an ADA payment with a memo and checks what Rust returned', async () => {
    const u = await adapter().buildPayment({ to: OTHER, lovelace: 2_000_000n, memo: 'merci' });
    expect(u.amount).toBe(2_000_000n);
    expect(u.maxFee).toBe(172_497n);
    expect(u.summary.memo).toEqual(['merci']);
    await expect(adapter().buildPayment({ to: 'Ae2tdPwUPEZCanmBz5g2GEwFqKTKpNJcGYPKfDxoNeKZ8bRHr8366kseiK2', lovelace: 1n })).rejects.toThrow(/Byron/);
    await expect(adapter().buildPayment({ to: OTHER })).rejects.toThrow(/manquant/);
    // Rust returning another amount, recipient or an extra foreign output: refused.
    const lying = backend({ build: async (to) => ({ tx: '84', summary: summary({ outputs: [{ ...summary().outputs[0]!, address: to, lovelace: '3000000' }] }), context: ctx }) });
    await expect(adapter(lying).buildPayment({ to: OTHER, lovelace: 2_000_000n })).rejects.toThrow(/ne correspond pas/);
    const extra = backend({ build: async () => ({ tx: '84', summary: summary({ outputs: [...summary().outputs, { ...summary().outputs[0]!, address: ENTERPRISE }] }), context: ctx }) });
    await expect(adapter(extra).buildPayment({ to: OTHER, lovelace: 2_000_000n })).rejects.toThrow(/ne correspond pas/);
  });

  it('builds a token payment carrying its min-ADA', async () => {
    const u = await adapter().buildPayment({ to: OTHER, token: { policy: POLICY, name: '74', quantity: '1' } });
    expect(u.amount).toBe(1_189_560n);
    expect(u.token?.quantity).toBe('1');
  });

  it('signs, broadcasts with id check, reads history', async () => {
    const b = backend();
    const a = adapter(b);
    const u = await a.buildPayment({ to: OTHER, lovelace: 2_000_000n });
    const s = await a.signTx(u, 'pw');
    expect(await a.broadcast(s)).toBe('ab'.repeat(32));
    expect(b.submitted).toEqual(['84a4a1']);
    const other = backend({ broadcast: async () => 'ff'.repeat(32) });
    await expect(adapter(other).broadcast(s)).rejects.toThrow(/inattendu/);
    const h = await a.getHistory();
    expect(h[0]).toMatchObject({ direction: 'out', amount: 2_172_497n, fee: 172_497n, memo: 'merci' });
    expect(h[1]).toMatchObject({ direction: 'in', amount: 10_000_000n });
    expect(await a.txStatus('ab'.repeat(32))).toEqual({ confirmations: 2 });
  });

  it('refuses an invalid own address', () => {
    expect(() => new CardanoAdapter({ chain: cardanoChain('mainnet'), address: ME, backend: backend() })).toThrow(/invalide/);
  });
});
