// SPDX-License-Identifier: GPL-3.0-or-later
//
// Preparing a Lightning payment: pick a provider, get the swap, have Rust check it, and build the
// on-chain deposit. Nothing here moves coins; the screen signs what this returns.

import { call, type LnInvoice, type LnSwapChecked, type LnSwapRecord, type NetFetch } from '@kyro/shared';
import type { AssetDef } from '@kyro/chains';
import { exolixFeeRecipients, feeForQuote, lnCreateSwap, lnErrorText, lnKyroFee, lnPairs, lnPairsFor, LN_MIN_INVOICE_MARGIN_SECS, LN_PROVIDERS, providerFee, type DepositPlan, type LnProvider, type LnProviderId, type LnSwapTerms } from '@kyro/swap';
import { t } from '../i18n';
import { buildDepositTx, buildKyroFeeTx, type DepositAdapters, type PreparedDeposit } from './crossSwap';

export interface LnPrepared {
  invoice: LnInvoice;
  provider: LnProvider;
  terms: LnSwapTerms;
  checked: LnSwapChecked;
  deposit: PreparedDeposit;
  kyroFee: bigint;
  kyroFeeBps: number;
  /** Both transfers' network fees (upper bound of what the adapter built). */
  networkFee: bigint;
  /** Everything that leaves the account. */
  total: bigint;
  /** Days until the refund, if the payment fails. */
  lockDays: number;
}

/** Why this invoice cannot be paid now, or null. */
export function invoiceProblem(i: LnInvoice, nowSecs: number): string | null {
  if (i.expiresAt < nowSecs + LN_MIN_INVOICE_MARGIN_SECS) return t('ln.errExpiresSoon');
  return null;
}

/** Rust's refusals are in English: the words the person reads, in their language. */
export function lnMessage(rust: string): string {
  const m = rust.toLowerCase();
  if (m.includes('no amount')) return t('ln.errNoAmount');
  if (m.includes('has expired')) return t('ln.errExpired');
  if (m.includes('another network')) return t('ln.errNetwork');
  if (m.includes('mainnet only')) return t('ln.errMainnet');
  if (m.includes('lightning invoice')) return t('ln.errBadInvoice');
  if (m.includes('expires too soon')) return t('ln.errExpiresSoon');
  if (m.includes('already sent')) return t('ln.errAlreadySent');
  if (/claim script|refund script|deposit address|swap timeout|swap fee|swap amount|swap claim key/.test(m)) return t('ln.errCheck', { why: rust });
  return rust;
}

interface Swapped {
  provider: LnProvider;
  terms: LnSwapTerms;
  keyIndex: number;
}

async function newSwap(fetcher: NetFetch, inv: LnInvoice): Promise<Swapped> {
  const amount = BigInt(inv.amountSat);
  const pairs = await lnPairs(fetcher);
  if (pairs.length === 0) throw new Error(t('ln.errNoProvider'));
  const usable = lnPairsFor(pairs, amount);
  if (usable.length === 0) {
    const min = Math.min(...pairs.map((p) => p.minimal));
    const max = Math.max(...pairs.map((p) => p.maximal));
    throw new Error(t('ln.errLimits', { min: min.toLocaleString(), max: max.toLocaleString() }));
  }
  let last = '';
  for (const pair of usable) {
    const key = await call('ln_swap_key');
    try {
      const terms = await lnCreateSwap(fetcher, pair, inv.invoice, key.publicKey, amount);
      return { provider: pair.provider, terms, keyIndex: key.index };
    } catch (e) {
      last = `${pair.provider.name}: ${lnErrorText(e)}`;
    }
  }
  throw new Error(t('ln.errRefused', { why: last }));
}

function reuse(r: LnSwapRecord): Swapped {
  const provider = LN_PROVIDERS.find((p) => p.id === r.provider);
  if (!provider) throw new Error(t('ln.errNoProvider'));
  return { provider, terms: r.terms, keyIndex: r.keyIndex };
}

export interface LnPrepareInput {
  invoice: LnInvoice;
  asset: AssetDef;
  adapters: DepositAdapters;
  fetcher: NetFetch;
  account: number;
  balance: bigint;
  /** Fiat price of BTC and the USD rate, for the fee curve. */
  priceFiat?: number;
  usdToFiat: number;
}

export async function prepareLnPayment(p: LnPrepareInput): Promise<LnPrepared> {
  const { invoice: inv, asset, adapters } = p;
  const problem = invoiceProblem(inv, Math.floor(Date.now() / 1000));
  if (problem) throw new Error(problem);
  const previous = (await call('ln_swaps')).find((r) => r.paymentHash === inv.paymentHash);
  if (previous?.depositTxid) throw new Error(t('ln.errAlreadySent'));
  // A swap that was never funded is kept by the provider: the same invoice cannot be sent twice.
  const swap = previous ? reuse(previous) : await newSwap(p.fetcher, inv);
  const checked = await call('ln_swap_accept', {
    request: { invoice: inv.invoice, terms: swap.terms, keyIndex: swap.keyIndex, provider: swap.provider.id as LnProviderId, ...(p.account ? { account: p.account } : {}) },
  });

  const expected = BigInt(checked.expectedAmount);
  const feeCfg = feeForQuote(providerFee('exolix'), { sell: { address: 'bitcoin', decimals: asset.decimals, symbol: asset.symbol, ...(p.priceFiat !== undefined ? { priceFiat: p.priceFiat } : {}) }, sellAmount: expected, usdToFiat: p.usdToFiat });
  if (feeCfg.kind === 'unavailable') throw new Error(feeCfg.reason);
  const bps = feeCfg.kind === 'fee' ? feeCfg.bps : 0;
  const recipient = exolixFeeRecipients().bitcoin;
  if (bps > 0 && !recipient) throw new Error(t('ln.errNoFeeAddress'));
  const kyroFee = lnKyroFee(expected, bps);

  const plan: DepositPlan = {
    depositAddress: checked.address,
    amountIn: expected,
    amountOut: BigInt(checked.invoiceSat),
    minAmountOut: BigInt(checked.invoiceSat),
    deadline: checked.expiresAt * 1000,
    kyroFeeBps: bps,
    oneClickFeeBps: 0,
    timeEstimateSecs: null,
    orderId: swap.terms.id,
    feeLevel: 'fast',
    ...(kyroFee > 0n && recipient ? { kyroFee: { recipient, amount: kyroFee } } : {}),
  };
  const deposit = await buildDepositTx(asset, adapters, plan);
  const feeTx = await buildKyroFeeTx(asset, adapters, plan);
  const networkFee = deposit.unsigned.maxFee + (feeTx?.unsigned.maxFee ?? 0n);
  const total = expected + kyroFee + networkFee;
  if (total > p.balance) throw new Error(t('ln.errBalance'));
  const tip = await call('btc_tip_height');
  return { invoice: inv, provider: swap.provider, terms: swap.terms, checked, deposit, kyroFee, kyroFeeBps: bps, networkFee, total, lockDays: daysUntil(checked.timeoutBlockHeight, tip) };
}

/** Rough days left until `height`, at 144 blocks a day. */
export function daysUntil(height: number, tip: number): number {
  return Math.max(0, Math.ceil((height - tip) / 144));
}
