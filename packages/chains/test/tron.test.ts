// SPDX-License-Identifier: GPL-3.0-or-later
//
// TronAdapter against a fake Rust backend. Addresses: Trezor firmware fixtures (`all ×12`,
// m/44'/195'/0'/0/0 = TY72iA3S…, /0/1 = TFz2CJn9…).

import { describe, expect, it } from 'vitest';
import { isTronAddress, TronAdapter, tronChain, TRON_USDT, type TronBackend, type TronEstimate, type TronTxSummary } from '../src';

const ME = 'TY72iA3SBtrds3QLYsS7LwYfkzXwAXCRWT';
const OTHER = 'TFz2CJn9CJb8C4i1Gke3jmZX2fRMJxniH2';
const USDT = TRON_USDT.testnet;

const estimate: TronEstimate = {
  bandwidthNeeded: 269, freeBandwidth: 600, stakedBandwidth: 0, bandwidthBurn: '0', activationFee: '1100000', recipientExists: false,
  energyNeeded: 0, energyAvailable: 0, energyFee: 100, energyBurn: '0', feeLimit: '0', totalBurn: '1100000', totalBurnMax: '1100000', balance: '150000000',
};

function summary(action: TronTxSummary['action'], extra: Partial<TronTxSummary> = {}): TronTxSummary {
  return {
    txid: 'ab'.repeat(32), owner: ME, action, feeLimit: '0', expiration: 1, timestamp: 0, refBlockBytes: 'cab8', refBlockHash: '883caa0677c5a7f3',
    memo: '', rawSize: 101, warnings: [], requiresExtraConfirmation: false, ...extra,
  };
}

function backend(over: Partial<TronBackend> = {}): TronBackend & { broadcasts: string[] } {
  const broadcasts: string[] = [];
  return {
    broadcasts,
    account: async () => ({ address: ME, exists: true, balance: '150000000', freeBandwidthLimit: 600, freeBandwidthUsed: 0, bandwidthLimit: 0, bandwidthUsed: 0, energyLimit: 0, energyUsed: 0 }),
    trc20Balance: async (c) => (c === USDT.contract ? '2500000' : '0'),
    txs: async () => [
      { txid: 'aa'.repeat(32), kind: 'trx', from: ME, to: OTHER, amount: '1000000', timestamp: 1_793_354_793_000, status: 'confirmed' },
      { txid: 'bb'.repeat(32), kind: 'trc20', from: OTHER, to: ME, amount: '1500000', token: { contract: USDT.contract, symbol: 'USDT', decimals: 6 }, timestamp: 1_793_354_000_000, status: 'confirmed' },
    ],
    build: async (to, amount, token) => ({
      raw: '0a02cab8',
      txid: 'ab'.repeat(32),
      summary: summary(token ? { type: 'trc20Transfer', contract: token, to, amount, callValue: '0' } : { type: 'trxTransfer', to, amount }),
      estimate,
    }),
    sign: async (raw) => ({ signature: 'cd'.repeat(64) + '1b', txid: 'ab'.repeat(32), summary: summary({ type: 'trxTransfer', to: OTHER, amount: '1000000' }, { rawSize: raw.length / 2 }), estimate }),
    broadcast: async (raw) => {
      broadcasts.push(raw);
      return 'ab'.repeat(32);
    },
    ...over,
  };
}

describe('TronAdapter (Nile)', () => {
  it('validates T… addresses (base58check, prefix 0x41)', () => {
    expect(isTronAddress(ME)).toBe(true);
    expect(isTronAddress(USDT.contract)).toBe(true);
    expect(isTronAddress('TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeD')).toBe(false);
    expect(isTronAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(false);
    expect(isTronAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(false);
    expect(() => new TronAdapter({ chain: tronChain('testnet'), address: 'nope', backend: backend() })).toThrow();
  });

  it('balances: TRX and the network’s own USDT', async () => {
    const a = new TronAdapter({ chain: tronChain('testnet'), address: ME, backend: backend() });
    expect(USDT.contract).toBe('TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf');
    expect(TRON_USDT.mainnet.contract).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(await a.getBalance()).toEqual([
      { assetId: 'trx', amount: 150_000_000n },
      { assetId: `trc20:${USDT.contract}`, amount: 2_500_000n },
    ]);
  });

  it('builds through Rust and checks the decoding matches the request', async () => {
    const b = backend();
    const a = new TronAdapter({ chain: tronChain('testnet'), address: ME, backend: b });
    const u = await a.buildTx({ to: OTHER, amount: 1_000_000n });
    expect(u.summary.action).toEqual({ type: 'trxTransfer', to: OTHER, amount: '1000000' });
    expect(u.estimate.activationFee).toBe('1100000');
    const t = await a.buildTx({ to: OTHER, amount: 1_500_000n, token: USDT });
    expect(t.token).toBe(USDT);
    await expect(a.buildTx({ to: ME, amount: 1n })).rejects.toThrow(/soi-même/);
    await expect(a.buildTx({ to: 'bad', amount: 1n })).rejects.toThrow(/invalide/);
    // Rust built something else (amount, recipient, unknown call): refused.
    for (const over of [
      { build: async (to: string) => ({ raw: '', txid: 'ab'.repeat(32), summary: summary({ type: 'trxTransfer', to, amount: '2' }), estimate }) },
      { build: async () => ({ raw: '', txid: 'ab'.repeat(32), summary: summary({ type: 'trxTransfer', to: ME, amount: '1000000' }), estimate }) },
      { build: async () => ({ raw: '', txid: 'ab'.repeat(32), summary: summary({ type: 'contractCall', contract: USDT.contract, selector: '095ea7b3', data: '', callValue: '0' }), estimate }) },
      { build: async (to: string, amount: string) => ({ raw: '', txid: 'cd'.repeat(32), summary: summary({ type: 'trxTransfer', to, amount }), estimate }) },
      { build: async (to: string, amount: string) => ({ raw: '', txid: 'ab'.repeat(32), summary: summary({ type: 'trxTransfer', to, amount }, { warnings: [{ kind: 'memo' }] }), estimate }) },
    ]) {
      const x = new TronAdapter({ chain: tronChain('testnet'), address: ME, backend: backend(over) });
      await expect(x.buildTx({ to: OTHER, amount: 1_000_000n })).rejects.toThrow(/ne correspond pas/);
    }
  });

  it('signs and broadcasts through Rust, txid checked', async () => {
    const b = backend();
    const a = new TronAdapter({ chain: tronChain('testnet'), address: ME, backend: b });
    const u = await a.buildTx({ to: OTHER, amount: 1_000_000n });
    const s = await a.signTx(u, 'pw');
    expect(s.signature).toHaveLength(130);
    expect(await a.broadcast(s)).toBe('ab'.repeat(32));
    expect(b.broadcasts).toEqual(['0a02cab8']);
    const bad = new TronAdapter({ chain: tronChain('testnet'), address: ME, backend: backend({ sign: async () => ({ signature: '00', txid: 'ab'.repeat(32), summary: u.summary, estimate }) }) });
    await expect(bad.signTx(u, 'pw')).rejects.toThrow(/Signature/);
  });

  it('maps history', async () => {
    const a = new TronAdapter({ chain: tronChain('testnet'), address: ME, backend: backend() });
    const h = await a.getHistory();
    expect(h[0]).toMatchObject({ assetId: 'trx', direction: 'out', amount: 1_000_000n, counterparty: OTHER, chainKey: 'tron' });
    expect(h[1]).toMatchObject({ assetId: `trc20:${USDT.contract}`, direction: 'in', amount: 1_500_000n, counterparty: OTHER });
  });
});
