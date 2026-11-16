// SPDX-License-Identifier: GPL-3.0-or-later
// The "Best price" panel of the Swap screen: what the selected quote costs and how it travels, then
// the other providers' quotes. Display only: Kyro keeps the first quote of the sorted list.

import type { ReactNode } from 'react';
import type { AssetDef } from '@kyro/chains';
import type { Quote } from '@kyro/swap';
import { fmtCrypto, fmtEta, fmtFiat, fmtPct } from '../lib/format';
import { cn } from '../lib/cn';
import { GLASS_ROW } from './kyro';
import { useT } from '../i18n';

const AMOUNT_DIGITS = 6;

type Side = Pick<AssetDef, 'symbol' | 'decimals'>;

/** "BTC → ETH". The same coin on two networks needs the networks to mean anything. */
export function routeLabel(sell: string, buy: string, sellChain: string, buyChain: string): string {
  return sell === buy ? `${sell} (${sellChain}) → ${buy} (${buyChain})` : `${sell} → ${buy}`;
}

function Cell({ label, value, first }: { label: ReactNode; value: ReactNode; first?: boolean }) {
  return (
    <span className={cn('flex min-w-0 flex-1 flex-col gap-1 px-5 py-3.5', !first && 'border-l border-white/[.06]')}>
      <span className="text-[11.5px] text-faint">{label}</span>
      <span className="figure truncate text-[13.5px] font-semibold">{value}</span>
    </span>
  );
}

/**
 * The route strip of the Swap screen (route, estimated fees, time, slippage), then one line with the
 * rest of the selected quote (route, amount, minimum, Kyro and provider fees) and the other quotes.
 * `quotes` is the list from `fetchQuotes`, best first: the first one is the quote Kyro uses.
 */
export function BestPrice({ quotes, sell, buy, sellChain, buyChain, currency, fees, tail, empty }: { quotes: Quote[]; sell: Side; buy: Side; sellChain: string; buyChain: string; currency: Parameters<typeof fmtFiat>[1]; fees?: ReactNode; tail?: { label: ReactNode; value: ReactNode }; empty?: ReactNode }) {
  const { t } = useT();
  const [best, ...others] = quotes;
  if (!best && !tail) return null;
  const providerFee = best && best.providerFeeFiat !== null && best.providerFeeFiat > 0 ? best.providerFeeFiat : null;
  return (
    <div className="flex flex-col items-center gap-2.5">
      <div className={cn('flex w-full rounded-[18px]', GLASS_ROW)}>
        <Cell first label={t('swap.route')} value={best ? best.providerName : '—'} />
        <Cell label={t('swap.feesEstimated')} value={best ? (fees ?? '—') : '—'} />
        {(!best || best.etaSecs !== undefined) && <Cell label={t('swap.estTime')} value={best?.etaSecs !== undefined ? fmtEta(best.etaSecs) : '—'} />}
        {tail && <Cell label={tail.label} value={tail.value} />}
      </div>
      {best ? (
        <span className="fade-in figure max-w-full px-2 text-center text-[12px] leading-[1.6] text-faint">
          <span className="mr-1.5 rounded-[6px] bg-up/[.12] px-1.5 py-px text-[10.5px] font-semibold tracking-[0.04em] text-up">{t('swap.bestTag')}</span>
          {routeLabel(sell.symbol, buy.symbol, sellChain, buyChain)} · {fmtCrypto(best.buyAmount, buy.decimals, buy.symbol, AMOUNT_DIGITS)} · {t('swap.minReceived')} {fmtCrypto(best.minBuyAmount, buy.decimals, buy.symbol, AMOUNT_DIGITS)} · {t('swap.kyroFee')} {fmtPct(best.kyroFeeBps / 100, { sign: false })}
          {providerFee !== null && ` · ${t('swap.providerFee')} ≈ ${fmtFiat(providerFee, currency)}${best.providerFeeIncluded ? '' : t('swap.providerFeeExtra')}`}
          {others.length > 0 && (
            <span className="block">
              <span className="mr-2 text-mute">{t('swap.otherQuotes')}</span>
              {others.map((q) => `${q.providerName} ${fmtCrypto(q.buyAmount, buy.decimals, buy.symbol, AMOUNT_DIGITS)}`).join(' · ')}
            </span>
          )}
        </span>
      ) : (
        empty && <span className="text-[12.5px] text-mute">{empty}</span>
      )}
    </div>
  );
}
