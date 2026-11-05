// SPDX-License-Identifier: GPL-3.0-or-later
// Tidy up small balances: pick a threshold and a target, see each conversion with its quote, fees
// and net amount, then run the ticked ones. Each one is the normal swap flow, reviewed, simulated
// and signed on its own, with a fresh quote: there is no batch signature.

import { useMemo, useState } from 'react';
import { allChains, assetsFor, unitsToNumber, type AssetDef } from '@kyro/chains';
import { fetchQuotes, type Quote } from '@kyro/swap';
import { useApp, useVault } from '../state/app';
import { useHistory } from '../state/history';
import { usePortfolio } from '../state/portfolio';
import { ownAddressOn, swapQuoteParams, usdRate } from '../lib/crossSwap';
import { cn } from '../lib/cn';
import { fmtCrypto, fmtFiat, fmtPct, sanitizeDecimalInput, toInputDecimal } from '../lib/format';
import { currentItem, runFinished, settle, startRun, stopRun, suspectAssetIds, TIDY_DEFAULT_THRESHOLD, tickedByDefault, tidyCost, tidyRows, tidySummary, type TidyCost, type TidyOutcome, type TidyRow, type TidyRun } from '../lib/tidy';
import { useAsync, useDebounced } from '../lib/useAsync';
import { CoinIcon, EmptyState } from '../components/kit';
import { useFeeOf, type FeeOf } from '../components/MissingFee';
import type { TokenPickerItem } from '../components/TokenPicker';
import { Button, Input, Notice, Spinner } from '../components/ui/primitives';
import { useT } from '../i18n';
import { SwapVault, TokenButton } from './Swap';

const QUOTE_SLIPPAGE_BPS = 50;
/** Quotes asked at the same time: a long list must not flood the providers. */
const QUOTE_POOL = 3;

async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

export function Tidy() {
  const { activeHw, navigate } = useApp();
  const { t } = useT();
  const [run, setRun] = useState<TidyRun<TidyRow> | null>(null);
  const [target, setTarget] = useState<AssetDef | null>(null);
  if (activeHw) {
    return (
      <div className="flex flex-1 items-center justify-center px-10">
        <EmptyState title={t('tidy.title')}>{t('tidy.hw')}</EmptyState>
      </div>
    );
  }
  if (run && target && !runFinished(run)) return <Running run={run} target={target} onChange={setRun} />;
  if (run && target) return <Summary run={run} target={target} onBack={() => navigate({ name: 'assets' })} />;
  return (
    <Picking
      onStart={(rows, to) => {
        setTarget(to);
        setRun(startRun(rows));
      }}
    />
  );
}

function Picking({ onStart }: { onStart: (rows: TidyRow[], target: AssetDef) => void }) {
  const { t, tp } = useT();
  const { network, swapProviders, settings, activeWatch } = useApp();
  const { accounts } = useVault();
  const pf = usePortfolio();
  const history = useHistory();
  const cur = settings.currency;
  const assets = useMemo(() => assetsFor(network), [network]);
  const chains = useMemo(() => allChains(network), [network]);
  const priceOf = (a: AssetDef) => pf.price(a.coingeckoId)?.price ?? null;
  const balanceOf = (id: string) => pf.balances.get(id) ?? 0n;

  const targets = useMemo(() => assets.filter((a) => !a.readOnly && !!ownAddressOn(accounts, chains.find((c) => c.key === a.chainKey))), [assets, chains, accounts]);
  const [targetId, setTargetId] = useState<string | null>(null);
  // Default: USDC on the chain of your largest holding, else that chain's coin.
  const top = pf.holdings.find((h) => !h.asset.readOnly)?.asset;
  const target = targets.find((a) => a.id === targetId) ?? targets.find((a) => a.chainKey === top?.chainKey && a.coingeckoId === 'usd-coin') ?? targets.find((a) => a.chainKey === top?.chainKey && a.kind === 'native') ?? targets[0];
  const [thresholdStr, setThresholdStr] = useState(String(TIDY_DEFAULT_THRESHOLD));
  const threshold = Number(useDebounced(thresholdStr, 400).replace(',', '.'));

  const held = useMemo(() => [...new Set(assets.filter((a) => (pf.balances.get(a.id) ?? 0n) > 0n).map((a) => a.chainKey))], [assets, pf.balances]);
  const { feeOf, ready } = useFeeOf(held);
  const suspects = useMemo(() => suspectAssetIds(history.data?.entries ?? [], (e) => (e.asset ? unitsToNumber(e.amount, e.asset.decimals) * (pf.price(e.asset.coingeckoId)?.price ?? 0) : null)), [history.data, pf]);
  const rows = useMemo(
    () => (target && Number.isFinite(threshold) && threshold > 0 ? tidyRows({ network, chains, assets, target, threshold, balanceOf, priceOf, feeOf, suspects, canSign: () => !activeWatch }) : []),
    [network, chains, assets, target, threshold, pf, feeOf, suspects, activeWatch],
  );
  const convertible = rows.filter((r) => !r.block);
  const quoteKey = JSON.stringify([target?.id, convertible.map((r) => [r.asset.id, r.amount.toString()])]);
  const usdToFiat = usdRate(cur, pf.price('usd-coin')?.price ?? pf.price('tether')?.price);
  const quotes = useAsync(
    ready && target && convertible.length > 0
      ? async () => {
          const list = await mapPool(convertible, QUOTE_POOL, async (r) => {
            const params = swapQuoteParams({ sell: r.asset, buy: target, sellChain: r.chain, buyChain: chains.find((c) => c.key === target.chainKey), sellAmount: r.amount, taker: ownAddressOn(accounts, r.chain), recipient: ownAddressOn(accounts, chains.find((c) => c.key === target.chainKey)), slippageBps: QUOTE_SLIPPAGE_BPS, usdToFiat, sellPrice: priceOf(r.asset) ?? undefined, buyPrice: priceOf(target) ?? undefined, nativePrice: nativePriceOf(assets, r.asset, priceOf) ?? undefined });
            const answer = params ? await fetchQuotes(swapProviders, params).catch(() => null) : null;
            return [r.asset.id, answer?.quotes[0] ?? null] as const;
          });
          return new Map<string, Quote | null>(list);
        }
      : null,
    [quoteKey, ready],
  );

  const costOf = (r: TidyRow): TidyCost | null => {
    const q = quotes.data?.get(r.asset.id);
    const price = target ? priceOf(target) : null;
    if (!q || !target || price === null) return null;
    return tidyCost({ value: r.value, received: unitsToNumber(q.buyAmount, target.decimals) * price, networkFee: networkFeeFiat(r, q, assets, feeOf, priceOf) });
  };
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const ticked = (r: TidyRow) => !r.block && !!quotes.data?.get(r.asset.id) && (ticks[r.asset.id] ?? tickedByDefault(costOf(r)));
  const selected = rows.filter(ticked);
  const net = selected.reduce((s, r) => s + (costOf(r)?.net ?? 0), 0);

  const items: TokenPickerItem[] = targets.map((a) => {
    const c = chains.find((x) => x.key === a.chainKey);
    return { id: a.id, symbol: a.symbol, name: a.name, network: c?.label ?? '', networkName: c?.name ?? '', coingeckoId: a.coingeckoId, held: balanceOf(a.id) > 0n, disabled: false, hint: `${a.name} · ${fmtCrypto(balanceOf(a.id), a.decimals)}`, icon: <CoinIcon asset={a} size={24} /> };
  });

  if (!target) return <EmptyState title={t('tidy.title')} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 px-8 pt-7 pb-6">
      <header className="flex flex-col gap-1 border-b border-line pb-4">
        <h1 className="screen-title">{t('tidy.title')}</h1>
        <p className="m-0 text-[13px] text-mute">{t('tidy.intro')}</p>
      </header>
      <div className="flex flex-wrap items-end gap-5">
        <label className="flex flex-col gap-1.5 text-[12.5px] text-mute">
          {t('tidy.threshold', { currency: cur })}
          <Input className="w-[120px]" inputMode="decimal" value={thresholdStr} onChange={(e) => setThresholdStr(sanitizeDecimalInput(e.target.value, 2))} />
        </label>
        <div className="flex flex-col gap-1.5 text-[12.5px] text-mute">
          {t('tidy.target')}
          <TokenButton title={t('tidy.target')} asset={target} items={items} onSelect={setTargetId} />
        </div>
        <span className="flex-1" />
        <Button disabled={quotes.loading} onClick={quotes.reload}>
          {t('tidy.refresh')}
        </Button>
      </div>

      <section className="min-h-0 flex-1 overflow-y-auto rounded-panel border border-line bg-card scroll-thin">
        {rows.length === 0 && <p className="m-0 px-5 py-6 text-[13px] text-mute">{pf.balancesLoaded ? t('tidy.empty') : t('common.loading')}</p>}
        {rows.map((r) => {
          const q = quotes.data?.get(r.asset.id);
          const cost = costOf(r);
          const pending = !r.block && quotes.loading && q === undefined;
          const native = assets.find((a) => a.chainKey === r.asset.chainKey && a.kind === 'native');
          const note = r.block === 'noRoute' ? t('tidy.noRoute', { symbol: target.symbol }) : r.block === 'noFees' ? t('tidy.noFees', { symbol: native?.symbol ?? '', chain: r.chain.label }) : pending ? null : !q ? t('tidy.noQuote') : !cost ? t('tidy.feesUnknown') : !tickedByDefault(cost) ? t('tidy.feesHigh', { pct: fmtPct(cost.ratio * 100, { sign: false, decimals: 0 }) }) : null;
          return (
            <label key={r.asset.id} className={cn('flex items-center gap-3 border-b border-line px-5 py-3 text-[13px] last:border-b-0', (r.block || (!pending && !q)) && 'opacity-60')}>
              <input type="checkbox" className="size-4 accent-[#7cc4ff]" disabled={!!r.block || !q} checked={ticked(r)} aria-label={t('tidy.tick', { symbol: r.asset.symbol, chain: r.chain.label })} onChange={(e) => setTicks((x) => ({ ...x, [r.asset.id]: e.target.checked }))} />
              <CoinIcon asset={r.asset} size={28} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">
                  {r.asset.symbol} <span className="font-normal text-mute">· {r.chain.label}</span>
                </span>
                <span className="truncate text-[12px] text-mute">
                  {fmtCrypto(r.amount, r.asset.decimals, r.asset.symbol)} · {fmtFiat(r.value, cur)}
                </span>
                {note && <span className="text-[12px] text-warn">{note}</span>}
              </span>
              {pending && <Spinner />}
              {q && (
                <span className="flex shrink-0 flex-col items-end text-[12.5px]">
                  <span className="font-medium">≈ {fmtCrypto(q.buyAmount, target.decimals, target.symbol, 6)}</span>
                  {cost ? (
                    <span className="text-mute">{t('tidy.feesNet', { fees: fmtFiat(cost.fees, cur), pct: fmtPct(cost.ratio * 100, { sign: false, decimals: 0 }), net: fmtFiat(cost.net, cur) })}</span>
                  ) : null}
                </span>
              )}
            </label>
          );
        })}
      </section>

      <footer className="flex items-center justify-between gap-4">
        <span className="text-[13px] text-mute">{selected.length > 0 ? `${tp('tidy.toSign', selected.length)} · ${t('tidy.netTotal', { net: fmtFiat(net, cur) })}` : t('tidy.nothingSelected')}</span>
        <Button variant="primary" size="xl" className="h-[46px] px-10" disabled={selected.length === 0} onClick={() => onStart(selected, target)}>
          {t('tidy.start')}
        </Button>
      </footer>
    </div>
  );
}

const nativePriceOf = (assets: AssetDef[], a: AssetDef, priceOf: (a: AssetDef) => number | null) => {
  const native = assets.find((x) => x.chainKey === a.chainKey && x.kind === 'native');
  return native ? priceOf(native) : null;
};

/**
 * What the chain charges for this conversion, in the display currency: the quote's own figure when
 * it has one, else the usual cost. An approval is counted whenever the route needs one, even if one
 * is already in place; an Exolix swap is two transfers.
 */
function networkFeeFiat(r: TidyRow, q: Quote, assets: AssetDef[], feeOf: FeeOf, priceOf: (a: AssetDef) => number | null): number | null {
  const native = assets.find((a) => a.chainKey === r.asset.chainKey && a.kind === 'native');
  const price = native ? priceOf(native) : null;
  if (!native || price === null) return null;
  const fiat = (units: bigint | null) => (units === null ? null : unitsToNumber(units, native.decimals) * price);
  const base = q.gasFeeFiat ?? fiat(feeOf(r.asset, q.tx.kind === 'deposit'));
  if (base === null) return null;
  const withToken = feeOf(r.asset) ?? 0n;
  const withoutToken = feeOf(native) ?? 0n;
  const approval = q.allowanceTarget && withToken > withoutToken ? fiat(withToken - withoutToken) ?? 0 : 0;
  return (q.provider === 'exolix' ? base * 2 : base) + approval;
}

function Running({ run, target, onChange }: { run: TidyRun<TidyRow>; target: AssetDef; onChange: (next: TidyRun<TidyRow>) => void }) {
  const { t } = useT();
  const item = currentItem(run);
  const index = run.outcomes.length;
  const last = run.outcomes[index - 1];
  if (!item) return null;
  const finish = (o: TidyOutcome) => onChange(settle(run, index, o));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-line px-8 py-3 text-[13px]">
        <span className="font-medium">
          {t('tidy.step', { n: index + 1, total: run.items.length })} · {item.asset.symbol} ({item.chain.label}) → {target.symbol}
        </span>
        {last && <span className={cn('min-w-0 flex-1 truncate', last.status === 'failed' ? 'text-down' : 'text-mute')}>{last.status === 'done' ? t('tidy.lastDone') : last.status === 'failed' ? t('tidy.lastFailed', { reason: last.reason }) : t('tidy.lastSkipped')}</span>}
        <span className="flex shrink-0 gap-2">
          <Button onClick={() => finish({ status: 'skipped' })}>{t('tidy.skip')}</Button>
          <Button onClick={() => onChange(stopRun(run))}>{t('tidy.stop')}</Button>
        </span>
      </div>
      <SwapVault key={index} sellAssetId={item.asset.id} buyAssetId={target.id} amount={toInputDecimal(item.amount, item.asset.decimals)} onOutcome={(o) => finish(o.status === 'cancelled' ? { status: 'skipped' } : o)} />
    </div>
  );
}

function Summary({ run, target, onBack }: { run: TidyRun<TidyRow>; target: AssetDef; onBack: () => void }) {
  const { t } = useT();
  const { navigate } = useApp();
  const { done, failed, skipped } = tidySummary(run);
  const line = (r: TidyRow) => `${fmtCrypto(r.amount, r.asset.decimals, r.asset.symbol)} · ${r.chain.label}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-8 pt-7 pb-6 scroll-thin">
      <header className="border-b border-line pb-4">
        <h1 className="screen-title">{t('tidy.summaryTitle', { symbol: target.symbol })}</h1>
      </header>
      {done.length > 0 && (
        <Notice tone="success">
          <strong className="font-semibold">{t('tidy.sumDone', { n: done.length })}</strong>
          <ul className="m-0 mt-1 list-disc pl-5">{done.map((r) => <li key={r.asset.id}>{line(r)}</li>)}</ul>
          <p className="m-0 mt-1 text-[12.5px]">{t('tidy.sumNote')}</p>
        </Notice>
      )}
      {failed.length > 0 && (
        <Notice tone="error">
          <strong className="font-semibold">{t('tidy.sumFailed', { n: failed.length })}</strong>
          <ul className="m-0 mt-1 list-disc pl-5">{failed.map((f) => <li key={f.item.asset.id}>{line(f.item)}: {f.reason}</li>)}</ul>
        </Notice>
      )}
      {skipped.length > 0 && (
        <Notice tone="info">
          <strong className="font-semibold">{t('tidy.sumSkipped', { n: skipped.length })}</strong>
          <ul className="m-0 mt-1 list-disc pl-5">{skipped.map((r) => <li key={r.asset.id}>{line(r)}</li>)}</ul>
        </Notice>
      )}
      <div className="flex gap-2">
        <Button variant="primary" onClick={onBack}>{t('tidy.backAssets')}</Button>
        <Button onClick={() => navigate({ name: 'history' })}>{t('tidy.history')}</Button>
      </div>
    </div>
  );
}
