// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBackend, type LnInvoice, type LnSwapChecked, type LnSwapRecord } from '@kyro/shared';
import type { AssetDef } from '@kyro/chains';
import { daysUntil, invoiceProblem, lnMessage, prepareLnPayment } from './lightning';
import { crossStatusLabel, type DepositAdapters } from './crossSwap';
import { lnBridgeOf } from '@kyro/swap';

const NOW = 1_800_000_000;
const invoice: LnInvoice = { invoice: 'lnbc1', amountMsat: 100_000_000, amountSat: 100_000, paymentHash: 'ab'.repeat(32), payee: '02', description: null, createdAt: NOW, expiresAt: NOW + 7_200 };
const terms = { id: 'abc123', address: 'bc1plock', expectedAmount: 100_402, claimPublicKey: '02', claimLeaf: 'a9', refundLeaf: '20', timeoutBlockHeight: 975_576 };
const record: LnSwapRecord = { terms, provider: 'coinos', invoice: 'lnbc1', paymentHash: invoice.paymentHash, invoiceSat: 100_000, expiresAt: NOW + 7_200, keyIndex: 2, account: 0, createdAt: NOW };
const checked: LnSwapChecked = { address: 'bc1plock', expectedAmount: 100_402, invoiceSat: 100_000, providerFeeSat: 402, timeoutBlockHeight: 975_576, expiresAt: NOW + 7_200 };
const asset = { id: 'btc', family: 'btc', symbol: 'BTC', decimals: 8, chainKey: 'bitcoin', coingeckoId: 'bitcoin' } as unknown as AssetDef;

function adapter(fee = 300n) {
  const buildTx = vi.fn(async (p: { to: string; amount: bigint }) => ({ family: 'btc', recipient: p.to, amount: p.amount, maxFee: fee, summary: { warnings: [], outputs: [[p.to, Number(p.amount), false]] } }));
  const params = { family: 'btc', satPerVb: 2 };
  return { family: 'btc', isValidAddress: () => true, estimateFees: async () => ({ options: { normal: { params }, fast: { params } } }), buildTx };
}

function input(balance = 200_000n, fetcher = vi.fn()) {
  return { invoice, asset, adapters: { btc: adapter(), evm: new Map() } as unknown as DepositAdapters, fetcher, account: 0, balance, usdToFiat: 1 };
}

describe('invoiceProblem', () => {
  it('asks for an hour', () => {
    expect(invoiceProblem({ ...invoice, expiresAt: NOW + 3_599 }, NOW)).not.toBeNull();
    expect(invoiceProblem({ ...invoice, expiresAt: NOW + 3_600 }, NOW)).toBeNull();
  });
});

describe('prepareLnPayment', () => {
  let calls: Array<{ cmd: string; args: unknown }>;
  let swaps: LnSwapRecord[];
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW * 1000, toFake: ['Date'] });
    calls = [];
    swaps = [];
    setBackend(async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'ln_swaps') return swaps;
      if (cmd === 'ln_swap_accept') return checked;
      if (cmd === 'btc_tip_height') return 974_568;
      throw new Error(`unexpected ${cmd}`);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses an invoice already sent', async () => {
    swaps = [{ ...record, depositTxid: 'aa'.repeat(32) }];
    await expect(prepareLnPayment(input())).rejects.toThrow();
    expect(calls.map((c) => c.cmd)).toEqual(['ln_swaps']);
  });

  it('reuses an unfunded swap and always goes through the Rust check', async () => {
    swaps = [record];
    const fetcher = vi.fn();
    const p = await prepareLnPayment(input(200_000n, fetcher));
    expect(fetcher).not.toHaveBeenCalled();
    expect(calls.some((c) => c.cmd === 'ln_swap_accept')).toBe(true);
    expect(p.deposit.plan).toMatchObject({ depositAddress: 'bc1plock', amountIn: 100_402n, feeLevel: 'fast', orderId: 'abc123' });
    expect(p.lockDays).toBe(7);
    // Unknown price: 90 bps of the deposit, sent to Kyro's own Bitcoin address.
    expect(p.kyroFee).toBe(904n);
    expect(p.total).toBe(100_402n + 904n + 600n);
  });

  it('refuses when the balance cannot carry both transfers', async () => {
    swaps = [record];
    await expect(prepareLnPayment(input(101_000n))).rejects.toThrow();
  });

  it('stops before contacting anyone when the invoice is too short', async () => {
    const fetcher = vi.fn();
    await expect(prepareLnPayment({ ...input(200_000n, fetcher), invoice: { ...invoice, expiresAt: NOW + 60 } })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('history wording', () => {
  it('speaks of the invoice, not of an arrival', () => {
    const bridge = lnBridgeOf('coinos');
    expect(crossStatusLabel('SUCCESS', 'Bitcoin', bridge)).toMatch(/pay/);
    expect(crossStatusLabel('FAILED', 'Bitcoin', bridge)).toMatch(/rembours|refund/);
    expect(crossStatusLabel('REFUNDED', 'Bitcoin', bridge)).toMatch(/rembours|refund/);
    expect(crossStatusLabel(undefined, 'Bitcoin', bridge)).toMatch(/attente|waiting/);
  });
});

it('words each refusal, and names a failed check', () => {
  for (const m of ['this invoice has no amount', 'this invoice has expired', 'this invoice is for another network', 'not a valid Lightning invoice', 'Lightning payments work on mainnet only']) expect(lnMessage(m)).not.toBe(m);
  expect(lnMessage("the provider's claim script is not tied to this invoice")).toContain('claim script');
  expect(lnMessage('network down')).toBe('network down');
});

it('counts days in blocks', () => {
  expect(daysUntil(975_576, 974_568)).toBe(7);
  expect(daysUntil(100, 200)).toBe(0);
});
