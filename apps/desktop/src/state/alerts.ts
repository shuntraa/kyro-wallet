// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the local alerts while the wallet is open: compares what the app already fetched (market
// refresh, history cache kept warm by `useHistoryWarmup`) with the user's rules. No request of its
// own, and only a template name, a symbol and a number go to Rust (`alert_notify`).

import { useEffect, useRef } from 'react';
import { call, intlLocale, type AlertNote } from '@kyro/shared';
import { useApp, useVault } from './app';
import { usePortfolio } from './portfolio';
import { cachedHistory, sourcesFingerprint } from './history';
import { emptyReceived, evaluatePrices, evaluateReceived, getAlertSettings, saveAlertSettings, type ReceivedState } from '../lib/alerts';
import { fmtCrypto } from '../lib/format';
import { readJson, writeJson } from '../lib/storage';

const RECEIVED_EVERY_MS = 60_000;

/** Rust accepts a short ticker only; an exotic one is simplified rather than refused. */
const safeSymbol = (s: string): string => s.replace(/[^A-Za-z0-9$.-]/g, '').slice(0, 12) || 'Kyro';

/** "70 123,45 EUR": digits and the currency code, whatever the local symbol. */
export function plainPrice(price: number, currency: string): string {
  const digits = price >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 4 };
  return `${new Intl.NumberFormat(intlLocale(), digits).format(price)} ${currency}`;
}

function show(note: AlertNote): void {
  void call('alert_notify', { note }).catch(() => {
    /* an alert that cannot be shown is not worth an error on screen */
  });
}

export function sendTestAlert(): Promise<void> {
  return call('alert_notify', { note: { kind: 'test' } });
}

export function useAlerts(): void {
  const { hideBalances, settings } = useApp();
  const { accounts, accountSources, isMultiAccount } = useVault();
  const pf = usePortfolio();
  const network = accounts.network;

  const priceOf = useRef(pf.price);
  priceOf.current = pf.price;
  const currency = settings.currency;
  // Only on a real market update: a price from the disk cache is not news.
  useEffect(() => {
    if (pf.marketUpdatedAt === null) return;
    const s = getAlertSettings();
    if (s.prices.length === 0) return;
    const { rules, hits } = evaluatePrices(s.prices, (id) => priceOf.current(id)?.price ?? null, currency);
    if (rules.some((r, i) => r !== s.prices[i])) saveAlertSettings({ ...s, prices: rules });
    for (const { rule, price } of hits) show({ kind: rule.direction === 'above' ? 'priceAbove' : 'priceBelow', symbol: safeSymbol(rule.symbol), price: plainPrice(price, currency) });
  }, [pf.marketUpdatedAt, currency]);

  const live = useRef({ accountSources, isMultiAccount, hideBalances });
  live.current = { accountSources, isMultiAccount, hideBalances };
  const fp = sourcesFingerprint(accountSources);
  useEffect(() => {
    const key = `alerts.received.${network}.${fp}`;
    const look = () => {
      if (!getAlertSettings().received) {
        // Switched on later = a new baseline, not a catch-up on everything since.
        writeJson(key, null);
        return;
      }
      const data = cachedHistory(network, live.current.accountSources, live.current.isMultiAccount);
      if (!data) return;
      const { state, hits } = evaluateReceived(data.entries, data.known, readJson<ReceivedState | null>(key, null) ?? emptyReceived(), Date.now());
      writeJson(key, state);
      for (const e of hits) {
        if (!e.asset) continue;
        show({ kind: 'received', symbol: safeSymbol(e.asset.symbol), amount: live.current.hideBalances ? null : fmtCrypto(e.amount, e.asset.decimals) });
      }
    };
    look();
    const id = window.setInterval(look, RECEIVED_EVERY_MS);
    return () => window.clearInterval(id);
  }, [network, fp]);
}
