// SPDX-License-Identifier: GPL-3.0-or-later
// Settings › Alerts: price levels and « funds received ». Stored on this device, shown as system
// notifications while Kyro is open and unlocked.

import { useMemo, useState } from 'react';
import { toIpcError } from '@kyro/shared';
import { useApp } from '../../state/app';
import { usePortfolio } from '../../state/portfolio';
import { sendTestAlert } from '../../state/alerts';
import { getAlertSettings, MAX_PRICE_ALERTS, parseLevel, saveAlertSettings, type AlertDirection, type AlertSettings, type PriceAlert } from '../../lib/alerts';
import { fmtFiat } from '../../lib/format';
import { Menu } from '../../components/ui/menu';
import { Button, Input, Notice, Segmented, Switch } from '../../components/ui/primitives';
import { IconChevronDown } from '../../components/icons';
import { useT } from '../../i18n';

interface Coin {
  id: string;
  symbol: string;
  name: string;
}

export function AlertsSection() {
  const { t } = useT();
  const { settings } = useApp();
  const pf = usePortfolio();
  const cur = settings.currency;
  const [state, setState] = useState<AlertSettings>(getAlertSettings);
  const [coinId, setCoinId] = useState('');
  const [direction, setDirection] = useState<AlertDirection>('above');
  const [level, setLevel] = useState('');
  const [testError, setTestError] = useState<string | null>(null);

  const update = (next: AlertSettings) => {
    setState(next);
    saveAlertSettings(next);
  };

  // What you hold first, then the market list.
  const coins = useMemo<Coin[]>(() => {
    const out = new Map<string, Coin>();
    for (const h of pf.holdings) if (h.asset.coingeckoId) out.set(h.asset.coingeckoId, { id: h.asset.coingeckoId, symbol: h.asset.symbol, name: h.asset.name });
    for (const m of pf.markets ?? []) if (!out.has(m.id)) out.set(m.id, { id: m.id, symbol: m.symbol.toUpperCase(), name: m.name });
    return [...out.values()];
  }, [pf.holdings, pf.markets]);

  const coin = coins.find((c) => c.id === coinId) ?? null;
  const parsed = parseLevel(level);
  const current = coin ? pf.price(coin.id)?.price ?? null : null;
  const full = state.prices.length >= MAX_PRICE_ALERTS;

  const add = () => {
    if (!coin || parsed === null || full) return;
    const rule: PriceAlert = { id: `${Date.now()}-${state.prices.length}`, coinId: coin.id, symbol: coin.symbol, direction, level: parsed, currency: cur, armed: true };
    update({ ...state, prices: [...state.prices, rule] });
    setLevel('');
  };

  const test = () => {
    setTestError(null);
    sendTestAlert().catch((e: unknown) => setTestError(toIpcError(e).message));
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col rounded-panel border border-line bg-card px-6 py-1.5">
        <div className="flex items-center justify-between gap-6 border-b border-line py-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[14.5px] font-medium">{t('settings.alertReceived')}</span>
            <span className="text-[13px] text-mute">{t('settings.alertReceivedDesc')}</span>
          </div>
          <Switch label={t('settings.alertReceived')} checked={state.received} onCheckedChange={(v) => update({ ...state, received: v })} />
        </div>
        <div className="flex items-center justify-between gap-6 py-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[14.5px] font-medium">{t('settings.alertTest')}</span>
            <span className="text-[13px] text-mute">{t('settings.alertTestDesc')}</span>
          </div>
          <Button variant="outline" onClick={test}>
            {t('settings.alertTestButton')}
          </Button>
        </div>
      </section>
      {testError && <Notice tone="error">{testError}</Notice>}

      <section className="flex flex-col gap-3.5 rounded-panel border border-line bg-card px-6 py-4">
        <span className="text-[14.5px] font-medium">{t('settings.alertPrices')}</span>
        <div className="flex flex-wrap items-center gap-2.5">
          <Menu
            value={coinId}
            onSelect={setCoinId}
            className="w-[280px]"
            items={coins.map((c) => ({ value: c.id, label: c.name, hint: c.symbol }))}
            trigger={
              <button type="button" aria-label={t('settings.alertCoin')} className="press flex h-9 min-w-[160px] items-center gap-2 rounded-ctl border border-line-2 bg-bg px-3 text-left text-[13px]">
                <span className="flex-1 truncate">{coin ? coin.symbol : t('settings.alertPickCoin')}</span>
                <IconChevronDown size={14} className="text-mute" />
              </button>
            }
          />
          <Segmented<AlertDirection>
            label={t('settings.alertDirection')}
            value={direction}
            onChange={setDirection}
            options={[
              { value: 'above', label: t('settings.alertAbove') },
              { value: 'below', label: t('settings.alertBelow') },
            ]}
          />
          <Input aria-label={t('settings.alertLevel')} inputMode="decimal" placeholder={cur} value={level} onChange={(e) => setLevel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} className="w-[130px]" />
          <Button variant="outline" disabled={!coin || parsed === null || full} onClick={add}>
            {t('settings.alertAdd')}
          </Button>
        </div>
        {current !== null && <span className="text-[12px] text-mute">{t('settings.alertNow', { price: fmtFiat(current, cur) })}</span>}
        {full && <span className="text-[12px] text-warn">{t('settings.alertFull', { max: MAX_PRICE_ALERTS })}</span>}
        {state.prices.length === 0 ? (
          <span className="text-[13px] text-mute">{t('settings.alertNone')}</span>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {state.prices.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-4 border-t border-line py-2.5">
                <span className="text-[13.5px]">{t(r.direction === 'above' ? 'settings.alertRuleAbove' : 'settings.alertRuleBelow', { symbol: r.symbol, level: fmtFiat(r.level, r.currency) })}</span>
                <span className="flex items-center gap-3">
                  {r.currency !== cur && <span className="text-[12px] text-mute">{t('settings.alertOtherCurrency', { currency: r.currency })}</span>}
                  <Button size="sm" onClick={() => update({ ...state, prices: state.prices.filter((x) => x.id !== r.id) })}>
                    {t('settings.alertRemove')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="m-0 px-1 text-[12px] leading-[1.5] text-faint">{t('settings.alertFooter')}</p>
    </div>
  );
}
