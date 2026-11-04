// SPDX-License-Identifier: GPL-3.0-or-later
//
// Dust protection: thresholds, what counts as unsolicited, and what the adapters leave out.

import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { HDKey } from '@scure/bip32';
import type { EsploraTx, EsploraUtxo } from '@kyro/shared';
import { dustUnits, isTinyLure, isUnsolicitedDust, LitecoinAdapter, LITECOIN_NETWORKS, ltcChain, selectCoins, setAsideOf, splitDust, type AssetDef, type OwnedCoin, type UtxoBackend } from '../src';

const ME = 'me1';
const OTHER = 'me2';
const STRANGER = 'stranger';
const own = new Set([ME, OTHER]);

const tx = (txid: string, height: number | null, from: string | null = STRANGER): EsploraTx => ({
  txid,
  status: height === null ? { confirmed: false } : { confirmed: true, block_height: height },
  vin: [{ txid: 'ff'.repeat(32), vout: 0, prevout: from === null ? null : { scriptpubkey: '', scriptpubkey_address: from, value: 1 } }],
  vout: [],
});
const coin = (value: bigint, txid = 'dust'): OwnedCoin => ({ txid, vout: 0, value, address: ME });

describe('per-chain thresholds', () => {
  it('covers every UTXO chain, and only them', () => {
    expect(dustUnits('btc')).toBe(5_460n);
    expect(dustUnits('ltc')).toBe(29_400n);
    expect(dustUnits('doge')).toBe(10_000_000n);
    expect(dustUnits('bch')).toBe(5_460n);
    expect(dustUnits('dash')).toBe(5_460n);
    expect(dustUnits('zec')).toBe(540n);
    expect(dustUnits('evm')).toBeUndefined();
    expect(dustUnits('xmr')).toBeUndefined();
  });

  it('stops at the threshold', () => {
    const txs = [tx('old', 10), tx('dust', 20)];
    for (const family of ['btc', 'ltc', 'doge', 'bch', 'dash', 'zec'] as const) {
      const limit = dustUnits(family)!;
      expect(isUnsolicitedDust(coin(limit), family, txs, own), family).toBe(true);
      expect(isUnsolicitedDust(coin(limit + 1n), family, txs, own), family).toBe(false);
    }
  });
});

describe('what is unsolicited', () => {
  const dust = coin(600n);

  it('a tiny coin from a stranger on a used address', () => {
    expect(isUnsolicitedDust(dust, 'btc', [tx('old', 10), tx('dust', 20)], own)).toBe(true);
  });

  it('also while unconfirmed, and when the server does not know the sender', () => {
    expect(isUnsolicitedDust(dust, 'btc', [tx('old', 10), tx('dust', null)], own)).toBe(true);
    expect(isUnsolicitedDust(dust, 'btc', [tx('old', 10), tx('dust', 20, null)], own)).toBe(true);
  });

  it('not on a fresh address: that is a small payment', () => {
    expect(isUnsolicitedDust(dust, 'btc', [tx('dust', 20)], own)).toBe(false);
    expect(isUnsolicitedDust(dust, 'btc', [tx('dust', 20), tx('later', 30)], own)).toBe(false);
  });

  it('not our own change', () => {
    expect(isUnsolicitedDust(dust, 'btc', [tx('old', 10), tx('dust', 20, OTHER)], own)).toBe(false);
  });

  it('stays spendable when the history cannot tell', () => {
    expect(isUnsolicitedDust(dust, 'btc', [tx('old', 10)], own)).toBe(false);
    expect(isUnsolicitedDust(dust, 'btc', [tx('old', 20), tx('dust', 20)], own)).toBe(false);
    expect(isUnsolicitedDust(dust, 'btc', [tx('old', null), tx('dust', null)], own)).toBe(false);
  });
});

describe('selection', () => {
  const coins = [
    { txid: 'big', vout: 0, value: 100_000n, type: 'p2wpkh' as const, address: ME },
    { txid: 'dust', vout: 0, value: 600n, type: 'p2wpkh' as const, address: ME },
  ];
  const history = async () => [tx('old', 10), tx('big', 11), tx('dust', 20)];

  it('reads no history when no coin is tiny, and splits when one is', async () => {
    let reads = 0;
    const count = async () => {
      reads++;
      return history();
    };
    await splitDust([coins[0]!], 'btc', count, own);
    expect(reads).toBe(0);
    const { spend, aside } = await splitDust(coins, 'btc', count, own);
    expect(reads).toBe(1);
    expect(spend.map((c) => c.txid)).toEqual(['big']);
    expect(setAsideOf(aside)).toEqual({ count: 1, amount: 600n });
  });

  it('a send that would need the dust fails unless it is included', async () => {
    const { spend, aside } = await splitDust(coins, 'btc', history, own);
    expect(() => selectCoins(spend, 100_000n, 1, 'p2wpkh')).toThrow();
    expect(selectCoins([...spend, ...aside], 100_400n, 1, 'p2wpkh').inputs).toHaveLength(2);
  });
});

describe('Litecoin adapter', () => {
  const SEED = Uint8Array.from('5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4'.match(/../g)!.map((h) => parseInt(h, 16)));
  const node = HDKey.fromMasterSeed(SEED, { public: 0x043587cf, private: 0x04358394 }).derive("m/84'/1'/0'");
  const address = bitcoin.payments.p2wpkh({ pubkey: node.deriveChild(0).deriveChild(0).publicKey!, network: LITECOIN_NETWORKS.testnet }).address!;
  const account = { address, xpub: node.publicExtendedKey, fingerprint: '73c5da0a', path: "m/84'/1'/0'" };
  const BIG = 'aa'.repeat(32);
  const DUST = 'bb'.repeat(32);
  const utxo = (txid: string, value: number): EsploraUtxo => ({ txid, vout: 0, value, status: { confirmed: true, block_height: 10 } });
  const stats = (sum: number, n: number) => ({ funded_txo_sum: sum, spent_txo_sum: 0, tx_count: n });
  const backend = {
    addressInfo: async (a: string) => ({ address: a, chain_stats: a === address ? stats(100_020_000, 2) : stats(0, 0), mempool_stats: stats(0, 0) }),
    addressUtxos: async (a: string) => (a === address ? [utxo(BIG, 100_000_000), utxo(DUST, 20_000)] : []),
    addressTxs: async () => [tx(BIG, 10), tx(DUST, 20)],
    txHex: async () => '',
    feeRates: async () => ({ fastestFee: 1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 }),
  } as unknown as UtxoBackend;
  const ltc = { id: 'ltc', chainKey: 'litecoin', family: 'ltc', kind: 'native', symbol: 'LTC', name: 'Litecoin', decimals: 8 } as unknown as AssetDef;
  const send = { asset: ltc, to: 'tltc1qv99w6gxa67tgy89xgrmtcf9nydnsws7sflulmg', amount: 0n, fee: { family: 'btc' as const, satPerVb: 1 }, max: true };
  const adapter = () => new LitecoinAdapter({ chain: ltcChain('testnet'), account, backend });
  const inputs = (psbt: string) => bitcoin.Psbt.fromBase64(psbt, { network: LITECOIN_NETWORKS.testnet }).data.inputs.length;

  it('keeps the balance whole and shows what is set aside', async () => {
    const a = adapter();
    expect((await a.getBalance())[0]?.amount).toBe(100_020_000n);
    expect(await a.setAside()).toEqual({ count: 1, amount: 20_000n });
  });

  it('leaves the dust out of a Max send unless it is included', async () => {
    const a = adapter();
    expect(inputs((await a.buildTx(send)).psbt)).toBe(1);
    expect(inputs((await a.buildTx({ ...send, includeDust: true })).psbt)).toBe(2);
  });
});

describe('EVM: tiny transfers in History', () => {
  const inbound = { direction: 'in', kind: 'transfer', amount: 5n };

  it('marks a transfer in worth under 1', () => {
    expect(isTinyLure(inbound, 'evm', 0.3)).toBe(true);
    expect(isTinyLure(inbound, 'evm', 12)).toBe(false);
  });

  it('leaves everything else alone', () => {
    expect(isTinyLure(inbound, 'evm', null)).toBe(false);
    expect(isTinyLure(inbound, 'btc', 0.3)).toBe(false);
    expect(isTinyLure({ ...inbound, direction: 'out' }, 'evm', 0.3)).toBe(false);
    expect(isTinyLure({ ...inbound, kind: 'approval' }, 'evm', 0.3)).toBe(false);
    expect(isTinyLure({ ...inbound, suspect: 'zero' }, 'evm', 0.3)).toBe(false);
  });
});
