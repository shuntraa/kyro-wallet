// SPDX-License-Identifier: GPL-3.0-or-later
// The "Best price" panel of the Swap screen: what the selected quote costs and how it travels, then
// the other providers' quotes. Display only: Kyro keeps the first quote of the sorted list.

import type { AssetDef } from '@kyro/chains';
import type { Quote } from '@kyro/swap';
import { fmtCrypto, fmtEta, fmtFiat, fmtPct } from '../lib/format';
import { Badge } from './ui/primitives';
import { useT } from '../i18n';

const AMOUNT_DIGITS = 6;

type Side = Pick<AssetDef, 'symbol' | 'decimals'>;

/** "BTC → ETH". The same coin on two networks needs the networks to mean anything. */
export function routeLabel(sell: string, buy: string, sellChain: string, buyChain: string): string {
  return sell === buy ? `${sell} (${sellChain}) → ${buy} (${buyChain})` : `${sell} → ${buy}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-10 items-center justify-between gap-3 border-t border-line">
      <span className="text-mute">{label}</span>
      <span className="truncate text-text2">{value}</span>
    </div>
  );
}

/** `quotes` is the list from `fetchQuotes`, best first: the first one is the quote Kyro uses. */
export function BestPrice({ quotes, sell, buy, sellChain, buyChain, currency }: { quotes: Quote[]; sell: Side; buy: Side; sellChain: string; buyChain: string; currency: Parameters<typeof fmtFiat>[1] }) {
  const { t } = useT();
  const [best, ...others] = quotes;
  if (!best) return null;
  const providerFee = best.providerFeeFiat !== null && best.providerFeeFiat > 0 ? best.providerFeeFiat : null;
  return (
    <div className="fade-in flex flex-col gap-2.5">
      <div className="flex flex-col rounded-box border border-line bg-bg px-4 text-[13px]">
        <div className="flex h-11 items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[14px] font-medium">{best.providerName}</span>
            <Badge tone="up">{t('swap.bestTag')}</Badge>
          </span>
          <span className="font-medium whitespace-nowrap">{fmtCrypto(best.buyAmount, buy.decimals, buy.symbol, AMOUNT_DIGITS)}</span>
        </div>
        <Row label={t('swap.route')} value={routeLabel(sell.symbol, buy.symbol, sellChain, buyChain)} />
        <Row label={t('swap.minReceived')} value={fmtCrypto(best.minBuyAmount, buy.decimals, buy.symbol, AMOUNT_DIGITS)} />
        <Row label={t('swap.kyroFee')} value={fmtPct(best.kyroFeeBps / 100, { sign: false })} />
        {providerFee !== null && <Row label={t('swap.providerFee')} value={`≈ ${fmtFiat(providerFee, currency)}${best.providerFeeIncluded ? '' : t('swap.providerFeeExtra')}`} />}
        {best.etaSecs !== undefined && <Row label={t('swap.estTime')} value={fmtEta(best.etaSecs)} />}
      </div>
      {others.length > 0 && (
        <div className="flex flex-col rounded-box border border-line bg-bg px-4 text-[13px]">
          <span className="eyebrow flex h-9 items-center">{t('swap.otherQuotes')}</span>
          {others.map((q) => (
            <Row key={q.provider} label={q.providerName} value={fmtCrypto(q.buyAmount, buy.decimals, buy.symbol, AMOUNT_DIGITS)} />
          ))}
        </div>
      )}
    </div>
  );
}
