// SPDX-License-Identifier: GPL-3.0-or-later
//
// Litecoin / Dogecoin adapters against a fake Rust backend. Keys: the public BIP39 test
// mnemonic "abandon … about" (seed below). The fake `signPsbt` signs with that key so the
// finalize / extract path is exercised; in the app, Rust signs.

import { describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { HDKey } from '@scure/bip32';
import type { EsploraAddressInfo, EsploraTx, EsploraUtxo } from '@kyro/shared';
import {
  createUtxoAdapters,
  dogeChain,
  DogecoinAdapter,
  DOGECOIN_NETWORKS,
  LitecoinAdapter,
  LITECOIN_NETWORKS,
  litecoinDust,
  ltcChain,
  selectUtxoCoins,
  LITECOIN_SPEC,
  DOGECOIN_SPEC,
  type AssetDef,
  type UtxoBackend,
  type UtxoTxSummary,
} from '../src';

/** BIP39 seed of "abandon ×11 about", empty passphrase. */
const SEED = Uint8Array.from('5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4'.match(/../g)!.map((h) => parseInt(h, 16)));
const TPUB = { public: 0x043587cf, private: 0x04358394 };
const XPUB = { public: 0x0488b21e, private: 0x0488ade4 };
const root = (versions = TPUB) => HDKey.fromMasterSeed(SEED, versions);
const FP = 0x73c5da0a.toString(16).padStart(8, '0');

function account(path: string, coin: 'ltc' | 'doge', versions = TPUB) {
  const node = root(versions).derive(path);
  const pub = node.deriveChild(0).deriveChild(0).publicKey!;
  const net = coin === 'ltc' ? LITECOIN_NETWORKS[versions === TPUB ? 'testnet' : 'mainnet'] : DOGECOIN_NETWORKS[versions === TPUB ? 'testnet' : 'mainnet'];
  const p = coin === 'ltc' ? bitcoin.payments.p2wpkh({ pubkey: pub, network: net }) : bitcoin.payments.p2pkh({ pubkey: pub, network: net });
  return { address: p.address!, xpub: node.publicExtendedKey, fingerprint: FP, path };
}

const info = (n: number): EsploraAddressInfo => ({
  address: '',
  chain_stats: { funded_txo_sum: n > 0 ? n : 0, spent_txo_sum: 0, tx_count: n > 0 ? 1 : 0 },
  mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
});

interface Fixture {
  balances: Record<string, number>;
  utxos: Record<string, EsploraUtxo[]>;
  txs?: Record<string, EsploraTx[]>;
  hex?: Record<string, string>;
  rates?: number;
  summaryFee?: (psbt: bitcoin.Psbt) => bigint;
}

function fakeBackend(f: Fixture, net: bitcoin.Network, coinType: number, purpose: number): UtxoBackend & { signed: number; broadcasts: string[] } {
  const state = { signed: 0, broadcasts: [] as string[] };
  return {
    get signed() {
      return state.signed;
    },
    broadcasts: state.broadcasts,
    addressInfo: async (a) => info(f.balances[a] ?? 0),
    addressUtxos: async (a) => f.utxos[a] ?? [],
    addressTxs: async (a) => f.txs?.[a] ?? [],
    txHex: async (t) => {
      const h = f.hex?.[t];
      if (!h) throw new Error(`no tx ${t}`);
      return h;
    },
    feeRates: async () => {
      const r = f.rates ?? 1;
      return { fastestFee: r, halfHourFee: r, hourFee: r, economyFee: r, minimumFee: r };
    },
    tipHeight: async () => 100,
    broadcast: async (hex) => {
      state.broadcasts.push(hex);
      return bitcoin.Transaction.fromHex(hex).getId();
    },
    // Stand-in for Rust: sign every input with the key its derivation names.
    signPsbt: async (b64) => {
      state.signed++;
      const psbt = bitcoin.Psbt.fromBase64(b64, { network: net });
      psbt.data.inputs.forEach((input, i) => {
        for (const d of input.bip32Derivation ?? []) {
          expect(d.path.startsWith(`m/${purpose}'/${coinType}'/0'/`)).toBe(true);
          const k = root().derive(d.path);
          psbt.signInput(i, { publicKey: k.publicKey!, sign: (h: Uint8Array) => k.sign(h) });
        }
      });
      const fee = f.summaryFee ? f.summaryFee(psbt) : null;
      const summary = { fee: String(fee ?? 0n) } as UtxoTxSummary;
      return { psbt: psbt.toBase64(), summary };
    },
  };
}

const asset = (id: 'ltc' | 'doge'): AssetDef => ({ id, chainKey: id === 'ltc' ? 'litecoin' : 'dogecoin', family: 'btc', kind: 'native', symbol: id.toUpperCase(), name: id, decimals: 8, coingeckoId: id, color: '', glyph: '' });

// ---------------------------------------------------------------- Litecoin

describe('Litecoin adapter (testnet4, BIP84 m/84\'/1\'/0\')', () => {
  const acct = account("m/84'/1'/0'", 'ltc');

  it('derives the same addresses as wallet-core', () => {
    // Printed by Rust (`utxo_live_litecoinspace_over_tor`, wallet_core::utxo_address).
    expect(acct.address).toBe('tltc1q6rz28mcfaxtmd6v789l9rrlrusdprr9pesrjxk');
    const main = account("m/84'/2'/0'", 'ltc', XPUB);
    expect(main.address).toBe('ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh');
    const a = new LitecoinAdapter({ chain: ltcChain('mainnet'), account: main, backend: fakeBackend({ balances: {}, utxos: {} }, LITECOIN_NETWORKS.mainnet, 2, 84) });
    expect(a.addressAt(0, 1).address).toBe('ltc1qwlezpr3890hcp6vva9twqh27mr6edadreqvhnn');
    expect(a.addressAt(0, 2).address).toBe('ltc1qc6aucuznvhh9uvux246x24vf9y9ncfk729m92s');
    // Wrong xpub for the stored address: refused.
    expect(() => new LitecoinAdapter({ chain: ltcChain('mainnet'), account: { ...main, address: acct.address } })).toThrow(/incohérente/i);
  });

  it('validates destinations like Rust (no Bitcoin or legacy 3…/2… P2SH)', () => {
    const a = new LitecoinAdapter({ chain: ltcChain('testnet'), account: acct, backend: fakeBackend({ balances: {}, utxos: {} }, LITECOIN_NETWORKS.testnet, 1, 84) });
    expect(a.isValidAddress('tltc1qv99w6gxa67tgy89xgrmtcf9nydnsws7sflulmg')).toBe(true);
    expect(a.isValidAddress('ltc1qcgnevr9rp7aazy62m4gen0tfzlssa52axwytt6')).toBe(false);
    expect(a.isValidAddress('tb1qkvwu9g3k2pdxewfqr7syz89r3gj557l3uuf9r9')).toBe(false);
    expect(a.isValidAddress('2N2JD6wb56AfK4tfmM6PwdVmoYk2dCKf4Br')).toBe(false);
    const q = bitcoin.payments.p2sh({ hash: new Uint8Array(20).fill(7), network: LITECOIN_NETWORKS.testnet }).address!;
    expect(q.startsWith('Q')).toBe(true);
    expect(a.isValidAddress(q)).toBe(true);
    const m = new LitecoinAdapter({ chain: ltcChain('mainnet'), account: account("m/84'/2'/0'", 'ltc', XPUB) });
    expect(m.isValidAddress('MHhghmmCTASDnuwpgsPUNJVPTFaj61GzaG')).toBe(true);
    expect(m.isValidAddress('LgKiekick9Ka7gYoYzAWGrEq8rFBJzYiyf')).toBe(true);
    expect(m.isValidAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(false);
  });

  it('dust thresholds are Litecoin Core’s', () => {
    expect(litecoinDust('p2wpkh')).toBe(2940n);
    expect(litecoinDust('p2pkh')).toBe(5460n);
    expect(litecoinDust('p2tr')).toBe(3300n);
  });

  const fixture = (): Fixture => ({
    balances: { [acct.address]: 100_000_000 },
    utxos: { [acct.address]: [{ txid: 'aa'.repeat(32), vout: 1, value: 100_000_000, status: { confirmed: true, block_height: 10 } }] },
    summaryFee: () => 141n,
  });

  it('builds a P2WPKH PSBT with key origins, change and Rust’s size model', async () => {
    const backend = fakeBackend(fixture(), LITECOIN_NETWORKS.testnet, 1, 84);
    const a = new LitecoinAdapter({ chain: ltcChain('testnet'), account: acct, backend });
    expect((await a.getBalance())[0]).toEqual({ assetId: 'ltc', amount: 100_000_000n });
    const fees = await a.estimateFees();
    expect(fees.hint).toBe('1 litoshi/vB');
    const u = await a.buildTx({ asset: asset('ltc'), to: 'tltc1qv99w6gxa67tgy89xgrmtcf9nydnsws7sflulmg', amount: 50_000_000n, fee: { family: 'btc', satPerVb: 1 } });
    expect(u.fee).toBe(141n);
    expect(u.size).toEqual({ family: 'btc', vsize: 141 });
    expect(u.dustFolded).toBe(0n);
    const psbt = bitcoin.Psbt.fromBase64(u.psbt, { network: LITECOIN_NETWORKS.testnet });
    expect(psbt.data.inputs[0]!.witnessUtxo?.value).toBe(100_000_000n);
    expect(psbt.data.inputs[0]!.nonWitnessUtxo).toBeUndefined();
    expect(psbt.data.inputs[0]!.bip32Derivation?.[0]?.path).toBe("m/84'/1'/0'/0/0");
    expect(psbt.data.outputs[1]!.bip32Derivation?.[0]?.path).toBe("m/84'/1'/0'/1/0");
    expect(u.summary.outputs[1]?.[2]).toBe(true);

    const signed = await a.signTx(u, 'pw');
    const tx = bitcoin.Transaction.fromHex(signed.hex);
    expect(tx.getId()).toBe(signed.txid);
    expect(tx.virtualSize()).toBeLessThanOrEqual(141);
    expect(tx.ins[0]!.witness).toHaveLength(2);
    expect(await a.broadcast(signed)).toBe(signed.txid);
    expect(backend.broadcasts).toEqual([signed.hex]);
  });

  it('folds a change below 2 940 litoshis into the fee and refuses a dust recipient', async () => {
    const a = new LitecoinAdapter({ chain: ltcChain('testnet'), account: acct, backend: fakeBackend(fixture(), LITECOIN_NETWORKS.testnet, 1, 84) });
    const to = 'tltc1qv99w6gxa67tgy89xgrmtcf9nydnsws7sflulmg';
    // 100 000 000 − 99 997 000 − 141 = 2 859 < 2 940: no change output.
    const u = await a.buildTx({ asset: asset('ltc'), to, amount: 99_997_000n, fee: { family: 'btc', satPerVb: 1 } });
    expect(u.summary.outputs).toHaveLength(1);
    expect(u.fee).toBe(3_000n);
    expect(u.dustFolded).toBe(3_000n - 110n);
    await expect(a.buildTx({ asset: asset('ltc'), to, amount: 2_939n, fee: { family: 'btc', satPerVb: 1 } })).rejects.toThrow(/poussière/i);
    await expect(a.buildTx({ asset: asset('ltc'), to, amount: 1000n, fee: { family: 'btc', satPerVb: 0.5 } })).rejects.toThrow(/minimum/i);
    await expect(a.buildTx({ asset: asset('doge'), to, amount: 10_000n, fee: { family: 'btc', satPerVb: 1 } })).rejects.toThrow(/Actif/i);
  });

  it('refuses a signature whose Rust-decoded fee differs from the built one', async () => {
    const f = fixture();
    f.summaryFee = () => 999n;
    const a = new LitecoinAdapter({ chain: ltcChain('testnet'), account: acct, backend: fakeBackend(f, LITECOIN_NETWORKS.testnet, 1, 84) });
    const u = await a.buildTx({ asset: asset('ltc'), to: 'tltc1qv99w6gxa67tgy89xgrmtcf9nydnsws7sflulmg', amount: 50_000_000n, fee: { family: 'btc', satPerVb: 1 } });
    await expect(a.signTx(u, 'pw')).rejects.toThrow(/frais/i);
  });

  it('coin selection matches the size model at higher rates', () => {
    const s = selectUtxoCoins([{ txid: 'a', vout: 0, value: 10_000_000n }, { txid: 'b', vout: 0, value: 5_000n }], 9_000_000n, 10, 'p2wpkh', 'p2wpkh', LITECOIN_SPEC.model, LITECOIN_SPEC.minOutput, 'litoshis');
    expect(s.vsize).toBe(141);
    expect(s.fee).toBe(1_410n);
    expect(s.change).toBe(10_000_000n - 9_000_000n - 1_410n);
  });
});

// ---------------------------------------------------------------- Dogecoin

describe('Dogecoin adapter (testnet, BIP44 m/44\'/1\'/0\', P2PKH)', () => {
  const acct = account("m/44'/1'/0'", 'doge');
  const net = DOGECOIN_NETWORKS.testnet;
  const other = bitcoin.payments.p2pkh({ hash: new Uint8Array(20).fill(9), network: net }).address!;

  function prevTx(value: bigint): bitcoin.Transaction {
    const tx = new bitcoin.Transaction();
    tx.version = 1;
    tx.addInput(new Uint8Array(32).fill(1), 0);
    tx.addOutput(bitcoin.address.toOutputScript(other, net), 1234n);
    tx.addOutput(bitcoin.address.toOutputScript(acct.address, net), value);
    return tx;
  }

  const fixture = (value = 10_000_000_000n, rate = 1_000): Fixture => {
    const prev = prevTx(value);
    return {
      balances: { [acct.address]: Number(value) },
      utxos: { [acct.address]: [{ txid: prev.getId(), vout: 1, value: Number(value), status: { confirmed: true } }] },
      hex: { [prev.getId()]: prev.toHex() },
      rates: rate,
      summaryFee: (p) => {
        const inSum = p.data.inputs.reduce((s, i, k) => s + bitcoin.Transaction.fromBuffer(i.nonWitnessUtxo!).outs[p.txInputs[k]!.index]!.value, 0n);
        return inSum - p.txOutputs.reduce((s, o) => s + o.value, 0n);
      },
    };
  };

  it('derives `n…` testnet / `D…` mainnet P2PKH addresses', () => {
    expect(acct.address.startsWith('n')).toBe(true);
    const main = account("m/44'/3'/0'", 'doge', XPUB);
    expect(main.address.startsWith('D')).toBe(true);
    const a = createUtxoAdapters({ network: 'mainnet', doge: main });
    expect(a.doge?.getAddress()).toBe(main.address);
    expect(a.ltc).toBeNull();
    expect(a.doge?.chain).toBe(dogeChain('mainnet'));
  });

  it('accepts only base58 Dogecoin addresses of its network', () => {
    const a = new DogecoinAdapter({ chain: dogeChain('mainnet'), account: account("m/44'/3'/0'", 'doge', XPUB) });
    expect(a.isValidAddress('DLSSSUS3ex7YNDACJDxMER1ZMW579Vy8Zy')).toBe(true);
    expect(a.isValidAddress('AETZJzedcmLM2rxCM6VqCGF3YEMUjA3jMw')).toBe(true);
    expect(a.isValidAddress('LgKiekick9Ka7gYoYzAWGrEq8rFBJzYiyf')).toBe(false);
    expect(a.isValidAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(false);
    const bech = bitcoin.address.toBech32(new Uint8Array(20).fill(3), 0, 'doge');
    expect(a.isValidAddress(bech)).toBe(false);
  });

  it('builds with the full previous transaction, signs (legacy) and finalizes', async () => {
    const backend = fakeBackend(fixture(), net, 1, 44);
    const a = new DogecoinAdapter({ chain: dogeChain('testnet'), account: acct, backend });
    const fees = await a.estimateFees();
    expect(fees.options.normal.params).toEqual({ family: 'btc', satPerVb: 1_000 });
    expect(fees.hint).toBe('0,01 DOGE/kB');
    const u = await a.buildTx({ asset: asset('doge'), to: other, amount: 1_000_000_000n, fee: { family: 'btc', satPerVb: 1_000 } });
    expect(u.size).toEqual({ family: 'btc', vsize: 226 });
    expect(u.fee).toBe(226_000n);
    const psbt = bitcoin.Psbt.fromBase64(u.psbt, { network: net });
    expect(psbt.data.inputs[0]!.nonWitnessUtxo).toBeDefined();
    expect(psbt.data.inputs[0]!.witnessUtxo).toBeUndefined();
    expect(psbt.data.inputs[0]!.bip32Derivation?.[0]?.path).toBe("m/44'/1'/0'/0/0");
    const signed = await a.signTx(u, 'pw');
    const tx = bitcoin.Transaction.fromHex(signed.hex);
    expect(tx.hasWitnesses()).toBe(false);
    expect(tx.byteLength()).toBeLessThanOrEqual(226);
    expect(tx.getId()).toBe(signed.txid);
  });

  it('a fee rate above bitcoinjs’ Bitcoin limit still finalizes (Rust showed the fee)', async () => {
    const a = new DogecoinAdapter({ chain: dogeChain('testnet'), account: acct, backend: fakeBackend(fixture(10_000_000_000n, 100_000), net, 1, 44) });
    const u = await a.buildTx({ asset: asset('doge'), to: other, amount: 1_000_000_000n, fee: { family: 'btc', satPerVb: 100_000 } });
    expect(u.fee).toBe(22_600_000n);
    await expect(a.signTx(u, 'pw')).resolves.toHaveProperty('hex');
  });

  it('never creates an output under 0.01 DOGE (soft dust): refuse the recipient, fold the change', async () => {
    const a = new DogecoinAdapter({ chain: dogeChain('testnet'), account: acct, backend: fakeBackend(fixture(), net, 1, 44) });
    await expect(a.buildTx({ asset: asset('doge'), to: other, amount: 999_999n, fee: { family: 'btc', satPerVb: 1_000 } })).rejects.toThrow(/poussière/i);
    // 100 DOGE − 99.99 DOGE − 0.00192 (192 B) = 0.00808 DOGE < 0.01: no change output.
    const u = await a.buildTx({ asset: asset('doge'), to: other, amount: 9_999_000_000n, fee: { family: 'btc', satPerVb: 1_000 } });
    expect(u.summary.outputs).toHaveLength(1);
    expect(u.fee).toBe(1_000_000n);
    expect(u.dustFolded).toBe(1_000_000n - 192_000n);
    await expect(a.buildTx({ asset: asset('doge'), to: other, amount: 1_000_000_000n, fee: { family: 'btc', satPerVb: 100 } })).rejects.toThrow(/minimum/i);
  });

  it('refuses a previous transaction that is not the one spent', async () => {
    const f = fixture();
    const txid = Object.keys(f.hex!)[0]!;
    f.hex![txid] = prevTx(20_000_000_000n).toHex();
    const a = new DogecoinAdapter({ chain: dogeChain('testnet'), account: acct, backend: fakeBackend(f, net, 1, 44) });
    await expect(a.buildTx({ asset: asset('doge'), to: other, amount: 1_000_000_000n, fee: { family: 'btc', satPerVb: 1_000 } })).rejects.toThrow(/incohérente/i);
  });

  it('maps history like Bitcoin', async () => {
    const f = fixture();
    f.txs = {
      [acct.address]: [
        { txid: 'bb'.repeat(32), status: { confirmed: true, block_time: 1_700_000_000 }, vin: [{ txid: 'cc'.repeat(32), vout: 0, prevout: { scriptpubkey: '', scriptpubkey_address: other, value: 5_000_000_000 } }], vout: [{ scriptpubkey: '', scriptpubkey_address: acct.address, value: 4_999_000_000 }], fee: 1_000_000 },
      ],
    };
    const a = new DogecoinAdapter({ chain: dogeChain('testnet'), account: acct, backend: fakeBackend(f, net, 1, 44) });
    const h = await a.getHistory();
    expect(h).toEqual([{ id: 'bb'.repeat(32), chainKey: 'dogecoin', assetId: 'doge', direction: 'in', amount: 4_999_000_000n, counterparty: other, time: 1_700_000_000_000, status: 'confirmed', kind: 'transfer' }]);
    expect(DOGECOIN_SPEC.rateHint(100_000)).toBe('1 DOGE/kB');
  });
});
