// SPDX-License-Identifier: GPL-3.0-or-later
// Speed up and cancel through the adapters: what is built, and what is refused, against fake
// backends. Rust's own checks of the same transactions are in crates/wallet-core/tests/replace.rs.

import { beforeAll, describe, expect, it } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import { setBackend, type Accounts, call, type NetRequest, type NetResponse } from '@kyro/shared';
import { createMockBackend } from '@kyro/shared/mock';
import { BitcoinAdapter, createAdapters, DOGECOIN_SPEC, type DogecoinAdapter, type LitecoinAdapter, LITECOIN_NETWORKS, EvmAdapter, evmChains, findAsset, LITECOIN_SPEC, RBF_SEQUENCE, ReplaceRefused, evmMinReplacementFee, type AssetDef } from '../src';

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ReplaceRefused) return e.reason;
    throw e;
  }
  return 'none';
};

describe('which coins are marked replaceable', () => {
  it('Litecoin yes, the others of the family no', () => {
    expect(LITECOIN_SPEC.replaceable).toBe(true);
    expect(DOGECOIN_SPEC.replaceable).toBeUndefined();
  });
});

describe('Bitcoin', () => {
  const PASSWORD = 'correct horse battery';
  const OUTSIDE = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
  const net = bitcoin.networks.testnet;
  let accounts: Accounts;
  let btc: BitcoinAdapter;
  let ltc: LitecoinAdapter;
  let doge: DogecoinAdapter;
  let asset: AssetDef;
  let mockInvoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Raw transactions and address histories the fake server knows. */
  let hex: Record<string, string>;
  let histories: Record<string, unknown[]>;

  beforeAll(async () => {
    const mock = createMockBackend({ network: 'testnet', confirm: () => true, preset: { password: PASSWORD, unlocked: true } });
    mockInvoke = mock.invoke;
    setBackend(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'btc_tx_hex' || cmd === 'ltc_tx_hex') {
        const h = hex[String(args?.txid)];
        if (!h) throw new Error('unknown tx');
        return h;
      }
      if (cmd === 'btc_address_txs' || cmd === 'ltc_address_txs') return histories[String(args?.address)] ?? [];
      return mockInvoke(cmd, args);
    });
    accounts = await call('accounts_get');
    const set = createAdapters(accounts);
    btc = set.btc!;
    ltc = set.ltc!;
    doge = set.doge!;
    asset = findAsset('testnet', 'btc')!;
  });

  /** A pending send of ours: 100,000 in, 60,000 out, `change` back, the rest as fee. */
  function pending(opts: { change?: bigint; sequence?: number; spender?: string } = {}) {
    hex = {};
    histories = {};
    const me = btc.addressAt('segwit', 0, 0);
    const script = (a: string) => bitcoin.address.toOutputScript(a, net);
    const fund = new bitcoin.Transaction();
    fund.version = 2;
    fund.addInput(new Uint8Array(32).fill(9), 0);
    fund.addOutput(script(opts.spender ?? me.address), 100_000n);
    hex[fund.getId()] = fund.toHex();
    const tx = new bitcoin.Transaction();
    tx.version = 2;
    tx.addInput(fund.getHash(), 0, opts.sequence ?? RBF_SEQUENCE);
    tx.addOutput(script(OUTSIDE), 60_000n);
    const changeAddr = btc.addressAt('segwit', 1, 0);
    const change = opts.change === undefined ? 39_000n : opts.change;
    if (change > 0n) tx.addOutput(script(changeAddr.address), change);
    const txid = tx.getId();
    hex[txid] = tx.toHex();
    const row = { txid, status: { confirmed: false }, vin: [], vout: [] };
    histories[me.address] = [row];
    return { txid, tx, me, changeAddr, row };
  }

  it('marks every send replaceable', async () => {
    const u = await btc.buildTx({ asset, to: OUTSIDE, amount: 1_000_000n, fee: { family: 'btc', satPerVb: 2 } });
    const psbt = bitcoin.Psbt.fromBase64(u.psbt, { network: net });
    expect(psbt.txInputs.length).toBeGreaterThan(0);
    expect(psbt.txInputs.every((i) => i.sequence === RBF_SEQUENCE)).toBe(true);
  });

  it('speeds up from the change, leaving the payment as it was', async () => {
    const { txid, tx, changeAddr } = pending();
    const p = await btc.planReplacement(txid, 'speedUp', 20);
    expect(p.oldFee).toBe(1_000n);
    const psbt = bitcoin.Psbt.fromBase64(p.unsigned.psbt, { network: net });
    expect(psbt.txInputs.map((i) => i.sequence)).toEqual([RBF_SEQUENCE]);
    expect(Buffer.from(psbt.txInputs[0]!.hash).equals(Buffer.from(tx.ins[0]!.hash))).toBe(true);
    expect(psbt.txOutputs[0]).toMatchObject({ address: OUTSIDE, value: 60_000n });
    expect(psbt.txOutputs[1]?.address).toBe(changeAddr.address);
    expect(psbt.txOutputs[1]?.value).toBe(100_000n - 60_000n - p.newFee);
    expect(psbt.data.outputs[1]?.bip32Derivation?.[0]?.path).toBe(changeAddr.path);
    expect(p.unsigned.summary.outputs[1]?.[2]).toBe(true);
    expect(p.replaces).toEqual({ txid, rawTx: tx.toHex(), mode: 'speedUp' });
    expect(p.recipient).toBe(OUTSIDE);
    expect(p.amount).toBe(60_000n);
  });

  it('pays at least the BIP125 minimum, however low the live rate', async () => {
    const { txid, tx } = pending();
    const p = await btc.planReplacement(txid, 'speedUp', 1);
    expect(p.newFee).toBeGreaterThanOrEqual(p.oldFee + BigInt(tx.virtualSize()));
  });

  it('cancels back to one of your addresses', async () => {
    const { txid } = pending({ change: 0n });
    const p = await btc.planReplacement(txid, 'cancel', 20);
    const outs = bitcoin.Psbt.fromBase64(p.unsigned.psbt, { network: net }).txOutputs;
    expect(outs).toHaveLength(1);
    expect(outs[0]?.address).not.toBe(OUTSIDE);
    expect(outs[0]?.value).toBe(100_000n - p.newFee);
    expect(p.unsigned.summary.outputs[0]?.[2]).toBe(true);
  });

  it('does the same on Litecoin, and nothing on Dogecoin', async () => {
    hex = {};
    histories = {};
    const net = LITECOIN_NETWORKS.testnet;
    const script = (a: string) => bitcoin.address.toOutputScript(a, net);
    const me = ltc.addressAt(0, 0);
    const back = ltc.addressAt(1, 0);
    const paid = 'tltc1qv99w6gxa67tgy89xgrmtcf9nydnsws7sflulmg';
    const fund = new bitcoin.Transaction();
    fund.version = 2;
    fund.addInput(new Uint8Array(32).fill(9), 0);
    fund.addOutput(script(me.address), 1_000_000n);
    hex[fund.getId()] = fund.toHex();
    const tx = new bitcoin.Transaction();
    tx.version = 2;
    tx.addInput(fund.getHash(), 0, RBF_SEQUENCE);
    tx.addOutput(script(paid), 600_000n);
    tx.addOutput(script(back.address), 399_000n);
    const txid = tx.getId();
    hex[txid] = tx.toHex();
    const row = { txid, status: { confirmed: false }, vin: [], vout: [] };
    histories[me.address] = [row];

    const up = await ltc.planReplacement(txid, 'speedUp', 20);
    const outs = bitcoin.Psbt.fromBase64(up.unsigned.psbt, { network: net });
    expect(outs.txInputs[0]?.sequence).toBe(RBF_SEQUENCE);
    expect(outs.txOutputs[0]).toMatchObject({ address: paid, value: 600_000n });
    expect(outs.txOutputs[1]?.value).toBe(1_000_000n - 600_000n - up.newFee);
    expect(outs.data.outputs[1]?.bip32Derivation?.[0]?.path).toBe(back.path);

    const off = await ltc.planReplacement(txid, 'cancel', 20);
    const cancelled = bitcoin.Psbt.fromBase64(off.unsigned.psbt, { network: net }).txOutputs;
    expect(cancelled).toHaveLength(1);
    expect(off.unsigned.summary.outputs[0]?.[2]).toBe(true);

    row.status.confirmed = true;
    expect(await refusal(ltc.planReplacement(txid, 'speedUp', 20))).toBe('confirmed');
    expect(await refusal(doge.planReplacement(txid, 'speedUp', 20))).toBe('unsupported');
  }, 60_000);

  it('refuses what cannot be replaced', async () => {
    let t = pending();
    t.row.status.confirmed = true;
    expect(await refusal(btc.planReplacement(t.txid, 'speedUp', 20))).toBe('confirmed');
    expect(await refusal(btc.planReplacement(t.txid, 'cancel', 20))).toBe('confirmed');

    t = pending({ sequence: 0xffffffff });
    expect(await refusal(btc.planReplacement(t.txid, 'speedUp', 20))).toBe('notReplaceable');

    t = pending({ change: 0n });
    expect(await refusal(btc.planReplacement(t.txid, 'speedUp', 20))).toBe('noChange');

    t = pending({ change: 300n });
    expect(await refusal(btc.planReplacement(t.txid, 'speedUp', 20))).toBe('noChange');

    t = pending({ spender: OUTSIDE });
    expect(await refusal(btc.planReplacement(t.txid, 'speedUp', 20))).toBe('notOurs');

    t = pending();
    histories[t.changeAddr.address] = [{ txid: 'child', status: { confirmed: false }, vin: [{ txid: t.txid, vout: 1, prevout: null }], vout: [] }];
    expect(await refusal(btc.planReplacement(t.txid, 'speedUp', 20))).toBe('hasChild');

    expect(await refusal(btc.planReplacement('ab'.repeat(32), 'speedUp', 20))).toBe('unknown');
  }, 60_000);
});

describe('EVM', () => {
  const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
  const OTHER = '0x0000000000000000000000000000000000000abc';
  const eth = evmChains('mainnet').find((c) => c.key === 'ethereum')!;
  const asset = { id: 'eth' } as AssetDef;
  const GWEI = 1_000_000_000n;
  const live = { maxFeePerGas: 50n * GWEI, maxPriorityFeePerGas: 2n * GWEI };

  const original = {
    from: ME,
    to: OTHER,
    nonce: '0x7',
    gas: '0xfde8',
    value: '0x10',
    input: '0xa9059cbb',
    type: '0x2',
    maxFeePerGas: '0x2540be400', // 10 gwei
    maxPriorityFeePerGas: '0x3b9aca00', // 1 gwei
    blockNumber: null as string | null,
    yParity: '0x1',
    r: '0x01',
    s: '0x02',
  };

  function adapter(tx: unknown, mined = 7) {
    const fetch = async (req: NetRequest): Promise<NetResponse> => {
      const r = JSON.parse(req.body ?? 'null') as { id: number; method: string };
      const result: Record<string, unknown> = { eth_getTransactionByHash: tx, eth_getTransactionCount: `0x${mined.toString(16)}`, eth_estimateGas: '0x5208' };
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: r.id, result: result[r.method] ?? null }) };
    };
    return new EvmAdapter({ chain: eth, address: ME, fetch });
  }

  it('speeds up with the same nonce, the same payment and higher fees', async () => {
    const p = await adapter(original).planReplacement('0xabc', 'speedUp', live, asset);
    expect(p.unsigned.tx).toMatchObject({ nonce: 7, to: '0x0000000000000000000000000000000000000aBc', valueWei: '16', data: '0xa9059cbb', gasLimit: 65_000, maxFeePerGas: (50n * GWEI).toString(), maxPriorityFeePerGas: (2n * GWEI).toString() });
    expect(p.replaces).toMatchObject({ hash: '0xabc', mode: 'speedUp', yParity: 1, r: '0x01', s: '0x02' });
    expect(p.replaces.tx).toMatchObject({ nonce: 7, maxFeePerGas: (10n * GWEI).toString(), gasLimit: 65_000 });
    expect(p.oldFee).toBe(65_000n * 10n * GWEI);
    expect(p.newFee).toBe(65_000n * 50n * GWEI);
  });

  it('raises both fields by 10% when the live level is lower', async () => {
    const p = await adapter(original).planReplacement('0xabc', 'speedUp', { maxFeePerGas: GWEI, maxPriorityFeePerGas: 1n }, asset);
    expect(p.unsigned.tx.maxFeePerGas).toBe(evmMinReplacementFee(10n * GWEI).toString());
    expect(p.unsigned.tx.maxPriorityFeePerGas).toBe(evmMinReplacementFee(GWEI).toString());
  });

  it('cancels with a 0-value send to yourself on the same nonce', async () => {
    const p = await adapter(original).planReplacement('0xabc', 'cancel', live, asset);
    expect(p.unsigned.tx).toMatchObject({ nonce: 7, to: ME, valueWei: '0', data: '0x', gasLimit: 21_000 });
    expect(p.recipient).toBe(ME);
    expect(p.amount).toBe(0n);
  });

  it('refuses what is mined, unknown, not ours or not EIP-1559', async () => {
    expect(await refusal(adapter({ ...original, blockNumber: '0x1' }).planReplacement('0xabc', 'speedUp', live, asset))).toBe('confirmed');
    expect(await refusal(adapter(original, 8).planReplacement('0xabc', 'cancel', live, asset))).toBe('confirmed');
    expect(await refusal(adapter(null).planReplacement('0xabc', 'speedUp', live, asset))).toBe('unknown');
    expect(await refusal(adapter({ ...original, from: OTHER }).planReplacement('0xabc', 'speedUp', live, asset))).toBe('notOurs');
    expect(await refusal(adapter({ ...original, type: '0x0' }).planReplacement('0xabc', 'speedUp', live, asset))).toBe('unsupported');
    expect(await refusal(adapter({ ...original, to: null }).planReplacement('0xabc', 'speedUp', live, asset))).toBe('unsupported');
  });
});
