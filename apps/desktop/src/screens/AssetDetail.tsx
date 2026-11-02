// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from 'react';
import { assetsFor, evmChains, findAsset, findChain, WATCH_ONLY_CHAINS, type AssetDef } from '@kyro/chains';
import { useApp, useVault } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { PERIODS, useCoinChart, type Period } from '../state/charts';
import { useHistory } from '../state/history';
import { useOnTorReady } from '../state/tor';
import { cn } from '../lib/cn';
import { fmtChartTime, fmtCrypto, fmtFiat, fmtNumber, fmtPct } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { CardanoTokensPanel } from '../components/Cardano';
import { XmrLockedNote, XmrSyncLine, useXmrStatus } from '../components/Monero';
import { AddressShort, BigFiat, CoinIcon, EmptyState, ErrorLine, HIDDEN, TrendPill } from '../components/kit';
import { SmoothChart } from '../components/charts';
import { HistoryRow } from '../components/HistoryRow';
import { useFavorites } from '../components/AssetLists';
import { AccountPicker } from '../components/AccountPicker';
import { Badge, Button, IconButton, Segmented, Skeleton, Spinner } from '../components/ui/primitives';
import { IconBack, IconDown, IconStake, IconStar, IconSwap, IconUp } from '../components/icons';
import { idx } from '../components/motion';
import { useT } from '../i18n';

function pickForCoin(list: AssetDef[]): AssetDef | undefined {
  return list.find((a) => a.kind === 'native') ?? list.find((a) => a.chainKey === 'ethereum') ?? list.find((a) => !a.readOnly) ?? list[0];
}

export function AssetDetail({ id }: { id: string }) {
  const { back, settings, navigate, hideBalances, network, activeHw, isMultiAccount, selectedAccounts, selectChainAccount } = useApp();
  const { accounts, adapters } = useVault();
  const pf = usePortfolio();
  const { favs, toggle } = useFavorites();
  const [period, setPeriod] = useState<Period>('1J');
  const { t } = useT();
  const cur = settings.currency;

  const asset: AssetDef | undefined = id.startsWith('cg:') ? undefined : findAsset(network, id);
  const coinId = asset?.coingeckoId ?? id.replace(/^cg:/, '');
  const coin = pf.marketById.get(coinId);
  const watch = WATCH_ONLY_CHAINS.find((w) => w.coingeckoId === coinId);
  // From the markets list (`cg:` id): the native coin, else the pinned token (Ethereum first).
  const supported = asset ?? pickForCoin(assetsFor(network).filter((a) => a.coingeckoId === coinId));
  const multi = !!supported && isMultiAccount(supported.family);
  const holding = supported ? (multi ? pf.accountHoldings.find((h) => h.asset.id === supported.id && h.account?.index === selectedAccounts[supported.family]) : pf.holdings.find((h) => h.asset.id === supported.id)) : undefined;
  const accountRows = supported && multi ? pf.accountHoldings.filter((h) => h.asset.id === supported.id && h.account) : [];
  const chart = useCoinChart(coinId, period);
  useOnTorReady(chart.reload);
  const month = useCoinChart(coinId, '1M');
  const history = useHistory();

  const name = supported?.name ?? coin?.name ?? watch?.name ?? coinId;
  const symbol = supported?.symbol ?? coin?.symbol ?? watch?.symbol ?? '';
  const color = supported?.color ?? watch?.color;
  const glyph = supported?.glyph ?? watch?.glyph ?? symbol.slice(0, 1);
  const price = pf.price(coinId);
  const points = chart.data ?? [];
  const values = points.map((p) => p[1]);
  const firstV = values[0];
  const lastV = values[values.length - 1];
  const change = period === '1J' ? price?.change24h ?? null : firstV && lastV ? ((lastV - firstV) / firstV) * 100 : null;
  const changeAbs = period === '1J' && price && price.change24h !== null ? price.price - price.price / (1 + price.change24h / 100) : firstV && lastV ? lastV - firstV : null;
  const m30 = month.data;
  const change30 = m30 && m30.length > 1 ? (((m30[m30.length - 1]?.[1] ?? 0) - (m30[0]?.[1] ?? 0)) / (m30[0]?.[1] || 1)) * 100 : null;

  const perNetwork = useMemo(() => {
    if (!supported || supported.family !== 'evm') return [];
    return evmChains(network).map((c) => {
      const twin = assetsFor(network).find((a) => a.chainKey === c.key && a.coingeckoId === supported.coingeckoId);
      return { chain: c, asset: twin, amount: twin ? pf.balances.get(twin.id) ?? null : null };
    });
  }, [supported, network, pf.balances]);

  // This asset's chain only: a spinner for a few seconds at most, then « Updating… » until its first
  // answer; a known (cached) answer refreshes silently.
  const chainPending = !!supported && (history.data?.pending.includes(supported.chainKey) ?? true);
  const chainKnown = !!supported && !!history.data?.known.includes(supported.chainKey);
  const [spinWindow, setSpinWindow] = useState(true);
  useEffect(() => {
    setSpinWindow(true);
    const tm = window.setTimeout(() => setSpinWindow(false), 4000);
    return () => window.clearTimeout(tm);
  }, [supported?.id]);
  const activity = (history.data?.entries ?? []).filter((e) => supported && e.assetId === supported.id).slice(0, 6);
  const address = supported ? ({ btc: accounts.btc?.segwit.address, sol: accounts.sol?.address, evm: accounts.evm?.address, ltc: accounts.ltc?.address, doge: accounts.doge?.address, bch: accounts.bch?.address, dash: accounts.dash?.address, tron: accounts.tron?.address, xrp: accounts.xrp?.address, ada: accounts.cardano?.address, xlm: accounts.stellar?.address, near: accounts.near?.address, sui: accounts.sui?.address, hbar: accounts.hbar?.address, kas: accounts.kas?.address, dot: accounts.polkadot?.address, algo: accounts.algo?.address, xmr: accounts.xmr?.address, ton: accounts.ton?.address, cosmos: accounts.cosmos?.address, apt: accounts.aptos?.address, zec: accounts.zec?.address }[supported.family] ?? null) : null;
  const fav = favs.includes(coinId);
  const stakeChain = supported ? ({ sol: 'sol', ada: 'ada', tron: 'tron' } as const)[supported.family as 'sol' | 'ada' | 'tron'] : undefined;
  const hbarAccount = useAsync(supported?.family === 'hbar' && adapters.hbar ? () => adapters.hbar!.account() : null, [supported?.id, adapters.hbar], { intervalMs: 30_000 });
  const adaAccount = useAsync(supported?.family === 'ada' && adapters.cardano ? () => adapters.cardano!.account() : null, [supported?.id, adapters.cardano], { intervalMs: 30_000 });
  const xmr = useXmrStatus(supported?.family === 'xmr' ? adapters.xmr : null);
  const xmrRunning = xmr.status?.running ?? false;
  const xmrWasRunning = useRef(false);
  useEffect(() => {
    if (xmrWasRunning.current && !xmrRunning) pf.refresh();
    xmrWasRunning.current = xmrRunning;
  }, [xmrRunning]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 px-8 pt-7 pb-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <IconButton label={t('common.back')} onClick={back} className="size-9">
            <IconBack size={16} />
          </IconButton>
          <CoinIcon glyph={glyph} color={color} symbol={symbol} id={supported?.id ?? `cg:${coinId}`} chain={supported?.chainKey} size={40} />
          <h1 className="screen-title truncate">{name}</h1>
          <span className="rounded-full bg-control px-2.5 py-0.5 text-[12px] font-medium text-text2">{symbol}</span>
          {coin?.rank && <span className="text-[12px] text-faint">{t('portfolio.rank', { rank: coin.rank })}</span>}
          {supported && <AccountPicker family={supported.family} />}
          <button type="button" aria-label={fav ? t('portfolio.removeFavorite') : t('portfolio.addFavorite')} aria-pressed={fav} onClick={() => toggle(coinId)} className={cn('press flex size-8 items-center justify-center rounded-ctl', fav ? 'text-ice' : 'text-faint hover:text-text2')}>
            <span key={String(fav)} className={fav ? 'pop-in inline-flex' : 'inline-flex'}>
              <IconStar size={18} filled={fav} />
            </span>
          </button>
        </div>
        {supported && !watch ? (
          <div className="flex gap-2">
            <Button variant="primary" size="lg" disabled={supported.readOnly} onClick={() => navigate({ name: 'send', assetId: supported.id })}>
              <IconUp size={16} /> {t('common.send')}
            </Button>
            <Button size="lg" onClick={() => navigate({ name: 'receive', family: supported.family })}>
              <IconDown size={16} /> {t('common.receive')}
            </Button>
            <Button
              size="lg"
              disabled={supported.family !== 'evm' && supported.family !== 'sol'}
              title={supported.family !== 'evm' && supported.family !== 'sol' ? t('portfolio.swapSoon', { name: supported.name }) : undefined}
              onClick={() => navigate({ name: 'swap', sellAssetId: supported.id })}
            >
              <IconSwap size={16} sw={2.2} /> Swap
            </Button>
            {supported.kind === 'native' && stakeChain && (
              <Button
                size="lg"
                disabled={!!activeHw}
                title={activeHw ? t('portfolio.stakingNoHw') : undefined}
                onClick={() => navigate({ name: 'staking', chain: stakeChain })}
              >
                <IconStake size={16} /> Staking
              </Button>
            )}
          </div>
        ) : (
          <Badge tone="ice" className="h-6 px-2">
            {watch ? t('portfolio.soonReadOnly') : t('portfolio.unsupported')}
          </Badge>
        )}
      </header>

      <div className="flex min-h-0 flex-[1.15] gap-5">
        <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden border-b border-line">
          <div className="flex items-start justify-between pt-2">
            <div className="flex flex-col gap-2.5">
              <span className="eyebrow">
                {t('portfolio.priceOf', { symbol, currency: cur })}
              </span>
              <span className="figure text-[60px] leading-none tracking-[-0.05em]">{price ? <BigFiat value={price.price} currency={cur} tick className="fade-in inline-block" /> : <Skeleton className="h-12 w-56" />}</span>
              {changeAbs !== null && change !== null && (
                <span>
                  <TrendPill change={change}>
                    {fmtFiat(Math.abs(changeAbs), cur)} · {fmtPct(Math.abs(change), { sign: false })}
                  </TrendPill>
                </span>
              )}
            </div>
            <Segmented label={t('portfolio.period')} value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p, label: t(`portfolio.period${p}`) }))} />
          </div>
          <div className="mt-auto flex min-h-0 flex-1 flex-col justify-end">
            {values.length > 1 ? (
              <SmoothChart
                key={period}
                values={values}
                height={250}
                fit
                defaultPoint="max"
                defaultLabel={t('portfolio.highest')}
                ariaLabel={t('portfolio.priceChartAria', { name })}
                padTop={70}
                renderTooltip={(i) => ({ label: fmtChartTime(points[i]?.[0] ?? Date.now()), value: fmtFiat(values[i] ?? 0, cur) })}
              />
            ) : chart.error ? (
              <ErrorLine className="pb-8" onRetry={chart.reload} error={chart.error}>
                {t('portfolio.chartError', { error: chart.error.message })}
              </ErrorLine>
            ) : (
              <div className="pb-8">
                <Skeleton className="h-[180px] w-full" />
              </div>
            )}
          </div>
        </section>

        <aside className="rise flex w-[360px] shrink-0 flex-col gap-3 rounded-panel border border-line bg-card px-6 py-6">
          {supported && !watch ? (
            <>
              <span className="eyebrow">{t('portfolio.yourBalance')}</span>
              <span className="figure text-[36px] leading-none tracking-[-0.035em]">{hideBalances ? HIDDEN : holding ? fmtCrypto(holding.amount, supported.decimals, supported.symbol) : '—'}</span>
              <span className="text-[14px] text-text2">
                {hideBalances ? HIDDEN : holding?.value !== null && holding?.value !== undefined ? t('portfolio.valueShare', { value: fmtFiat(holding.value, cur), share: fmtNumber(holding.share * 100, 0) }) : t('portfolio.priceUnavailable')}
              </span>
              <div className="h-[3px] overflow-hidden rounded-full bg-control-2">
                <div className="h-full origin-left rounded-full bg-ice transition-[width] duration-500" style={{ width: `${Math.round((holding?.share ?? 0) * 100)}%` }} />
              </div>
              {accountRows.length > 1 && (
                <div className="mt-2 flex flex-col">
                  <span className="eyebrow pb-2">{t('portfolio.perAccount')}</span>
                  {accountRows.map((h) => {
                    const active = h.account?.index === selectedAccounts[supported.family];
                    return (
                      <button
                        key={h.key}
                        type="button"
                        aria-pressed={active}
                        onClick={() => h.account && selectChainAccount(h.account.family, h.account.index)}
                        className="flex h-9 items-center justify-between gap-3 border-t border-line text-left text-[13px] hover:text-text"
                      >
                        <span className={cn('flex min-w-0 items-center gap-2', active ? 'text-text' : 'text-text2')}>
                          <span className={cn('size-1.5 shrink-0 rounded-full', active ? 'bg-ice' : 'bg-faint')} />
                          <span className="truncate">{h.account?.name}</span>
                        </span>
                        <span className={h.amount > 0n ? 'font-medium' : 'text-mute'}>{hideBalances ? HIDDEN : fmtCrypto(h.amount, supported.decimals)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {perNetwork.length > 0 && (
                <div className="mt-2 flex flex-col">
                  <span className="eyebrow pb-2">{t('portfolio.perNetwork')}</span>
                  {perNetwork.map(({ chain, asset: a, amount }) => (
                    <div key={chain.key} className="flex h-9 items-center justify-between border-t border-line text-[13px]">
                      <span className="flex items-center gap-2 text-text2">
                        <span className={cn('size-1.5 rounded-full', a && amount && amount > 0n ? 'bg-ice' : 'bg-faint')} />
                        {chain.name}
                      </span>
                      <span className={a && amount && amount > 0n ? 'font-medium' : 'text-mute'}>{!a ? t('portfolio.notListed') : amount === null ? '—' : hideBalances ? HIDDEN : `${fmtCrypto(amount, a.decimals)}${chain.phase === 2 ? ` · ${t('portfolio.phase2')}` : ''}`}</span>
                    </div>
                  ))}
                  {network === 'testnet' && <span className="pt-2 text-[12px] text-faint">{t('portfolio.l2OnMainnet')}</span>}
                </div>
              )}
              {supported.family === 'ada' && <CardanoTokensPanel account={adaAccount.data} hidden={hideBalances} />}
              {supported.family === 'hbar' && hbarAccount.data && (
                <div className="mt-2 flex flex-col gap-1 border-t border-line pt-3 text-[13px]">
                  <span className="eyebrow">{t('portfolio.hbarAccount')}</span>
                  {hbarAccount.data.exists ? (
                    <span className="font-mono text-text2">{hbarAccount.data.accountIdChecksum ?? hbarAccount.data.accountId}</span>
                  ) : (
                    <span className="text-[12px] text-warn">{t('portfolio.hbarNoAccount')}</span>
                  )}
                  {hbarAccount.data.hollow && <span className="text-[12px] text-mute">{t('portfolio.hbarHollow')}</span>}
                </div>
              )}
              {supported.family === 'xmr' && (
                <div className="mt-2 flex flex-col gap-2">
                  <XmrLockedNote status={xmr.status} hidden={hideBalances} />
                  <XmrSyncLine status={xmr.status} error={xmr.error} onRetry={xmr.sync} />
                </div>
              )}
              <div className="flex-1" />
              {address && supported.family !== 'ada' && (
                <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
                  <AddressShort address={address} />
                  <Button size="sm" onClick={() => navigate({ name: 'receive', family: supported.family })}>
                    {t('portfolio.qrCode')}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState title={watch ? t('portfolio.comingPhase4', { name }) : t('portfolio.assetUnsupported')}>
              {watch ? t('portfolio.comingHint') : t('portfolio.unsupportedHint')}
            </EmptyState>
          )}
        </aside>
      </div>

      <div className="flex min-h-0 flex-1 gap-5">
        {/* Price-only assets have no account here: no activity card. */}
        {supported && (
        <section className="rise flex min-w-0 flex-1 flex-col overflow-hidden rounded-panel border border-line bg-card" style={idx(1)}>
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-6">
            <span className="text-[15px] font-medium tracking-[-0.01em]">{t('portfolio.activityOf', { symbol })}</span>
            <button type="button" onClick={() => navigate({ name: 'history' })} className="text-[13px] font-medium text-ice hover:underline">
              {t('portfolio.seeAll')}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
            {activity.length === 0 && supported?.family === 'dot' && history.data?.dotHistory === 'unavailable' ? (
              <EmptyState title={t('portfolio.dotNoHistoryTitle')}>{network === 'testnet' ? t('portfolio.dotNoHistoryTestnet') : t('portfolio.dotNoHistory')}</EmptyState>
            ) : activity.length === 0 ? (
              <EmptyState title={t('portfolio.noActivity')} action={chainPending && !chainKnown ? (spinWindow ? <Spinner className="size-3.5 text-mute" /> : <span className="text-[12px] text-mute">{t('portfolio.updating')}</span>) : undefined}>
                {t('portfolio.noActivityHint')}
              </EmptyState>
            ) : (
              <div className="stagger">{activity.map((e, i) => <HistoryRow key={e.id} i={i} e={e} compact price={price?.price ?? null} currency={cur} hidden={hideBalances} />)}</div>
            )}
          </div>
        </section>
        )}
        <section className={cn('rise flex shrink-0 flex-col rounded-panel border border-line bg-card px-6 py-5', supported ? 'w-[360px]' : 'flex-1')} style={idx(2)}>
          <div className="flex items-baseline justify-between pb-3">
            <span className="text-[15px] font-medium tracking-[-0.01em]">{t('portfolio.market')}</span>
          </div>
          {[
            [t('portfolio.high24h'), coin?.high24h !== null && coin?.high24h !== undefined ? fmtFiat(coin.high24h, cur) : '—', ''],
            [t('portfolio.low24h'), coin?.low24h !== null && coin?.low24h !== undefined ? fmtFiat(coin.low24h, cur) : '—', ''],
            [t('portfolio.change7d'), fmtPct(coin?.change7d), (coin?.change7d ?? 0) >= 0 ? 'text-up' : 'text-down'],
            [t('portfolio.change30d'), fmtPct(change30), (change30 ?? 0) >= 0 ? 'text-up' : 'text-down'],
          ].map(([k, v, c]) => (
            <div key={k} className="flex h-10 items-center justify-between border-t border-line text-[13.5px]">
              <span className="text-mute">{k}</span>
              <span className={cn('font-medium', v === '—' ? 'text-mute' : c)}>{v}</span>
            </div>
          ))}
          {supported && findChain(network, supported.chainKey)?.network === 'testnet' && <p className="mt-auto pt-3 text-[12px] leading-[1.5] text-faint">{t('portfolio.testnetPricesNote')}</p>}
        </section>
      </div>
    </div>
  );
}
