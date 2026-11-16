// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from 'react';
import { assetsFor, evmChains, findAsset, findChain, type AssetDef } from '@kyro/chains';
import { canSwapFrom } from '../lib/crossSwap';
import { useApp, useVault } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { coinPeriods, useCoinChart, type Period } from '../state/charts';
import { useGains } from '../state/gains';
import { useHistory } from '../state/history';
import { useOnTorReady } from '../state/tor';
import { cn } from '../lib/cn';
import { HW_STAKE } from '../lib/staking';
import { fmtChartTime, fmtCrypto, fmtFiat, fmtNumber, fmtPct } from '../lib/format';
import { isHeld, lockTimeLeft, unlockUtc } from '../lib/btcLock';
import { intlLocale } from '@kyro/shared';
import { useAsync } from '../lib/useAsync';
import { ReceivedTokens } from '../components/ReceivedTokens';
import { CardanoTokensPanel } from '../components/Cardano';
import { XmrLockedNote, XmrSyncLine, useXmrStatus } from '../components/Monero';
import { AddressShort, CoinIcon, EmptyState, ErrorLine, HIDDEN, trendColor } from '../components/kit';
import { Annotated, BIG, CoinGlow, CoinPill, CoinRound, DISPLAY, GLOW, Glass, GlassButton, IceSquare, LABEL, Segmented, Side, THIN, type Note, type Seg } from '../components/kyro';
import { SplitFiat, coinTint, useWidth } from '../components/kyroParts';
import { SmoothChart } from '../components/charts';
import { AssetGains } from '../components/Gains';
import { LockedLine, useBtcLocks } from './BtcLocks';
import { HistoryRow } from '../components/HistoryRow';
import { useFavorites } from '../components/AssetLists';
import { AccountPicker } from '../components/AccountPicker';
import { Badge, Skeleton, Spinner } from '../components/ui/primitives';
import { IconBack, IconDown, IconLock, IconQr, IconStake, IconStar, IconSwap, IconUp } from '../components/icons';
import { idx } from '../components/motion';
import { useT } from '../i18n';

function pickForCoin(list: AssetDef[]): AssetDef | undefined {
  return list.find((a) => a.kind === 'native') ?? list.find((a) => a.chainKey === 'ethereum') ?? list.find((a) => !a.readOnly) ?? list[0];
}

export function AssetDetail({ id }: { id: string }) {
  const { back, settings, navigate, hideBalances, network, activeHw, activeWatch, isMultiAccount, selectedAccounts, selectChainAccount } = useApp();
  const { accounts, adapters } = useVault();
  const pf = usePortfolio();
  const { favs, toggle } = useFavorites();
  const [period, setPeriod] = useState<Period>('1A');
  const { t } = useT();
  const cur = settings.currency;

  const asset: AssetDef | undefined = id.startsWith('cg:') ? undefined : findAsset(network, id);
  const coinId = asset?.coingeckoId ?? id.replace(/^cg:/, '');
  const coin = pf.marketById.get(coinId);
  // From the markets list (`cg:` id): the native coin, else the pinned token (Ethereum first).
  const supported = asset ?? pickForCoin(assetsFor(network).filter((a) => a.coingeckoId === coinId));
  const multi = !!supported && isMultiAccount(supported.family);
  const holding = supported ? (multi ? pf.accountHoldings.find((h) => h.asset.id === supported.id && h.account?.index === selectedAccounts[supported.family]) : pf.holdings.find((h) => h.asset.id === supported.id)) : undefined;
  const accountRows = supported && multi ? pf.accountHoldings.filter((h) => h.asset.id === supported.id && h.account) : [];
  // « All » is hidden for coins without a long history source: fall back to 1Y if it was picked.
  const shown = period === 'Tout' && !coinPeriods(coinId).includes('Tout') ? '1A' : period;
  const chart = useCoinChart(coinId, shown);
  useOnTorReady(chart.reload);
  const month = useCoinChart(coinId, '1M');
  const history = useHistory();
  const gains = useGains();

  const name = supported?.name ?? coin?.name ?? coinId;
  const symbol = supported?.symbol ?? coin?.symbol ?? '';
  const color = supported?.color;
  const glyph = supported?.glyph ?? symbol.slice(0, 1);
  const price = pf.price(coinId);
  const points = chart.data ?? [];
  const values = useMemo(() => points.map((p) => p[1]), [points]);
  const times = useMemo(() => points.map((p) => p[0]), [points]);
  const firstV = values[0];
  const lastV = values[values.length - 1];
  // « All » has no change until its first point is the coin's start (1Y alone would say « since the start »).
  const hasRange = !!firstV && !!lastV && !chart.partial;
  const change = period === '1J' ? price?.change24h ?? null : hasRange ? ((lastV - firstV) / firstV) * 100 : null;
  const changeAbs = period === '1J' && price && price.change24h !== null ? price.price - price.price / (1 + price.change24h / 100) : hasRange ? lastV - firstV : null;
  const spanMs = (points[points.length - 1]?.[0] ?? 0) - (points[0]?.[0] ?? 0);
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
  const tokenFamily = supported && !supported.contract && (supported.family === 'sui' || supported.family === 'cosmos' || supported.family === 'bch') ? supported.family : null;
  const tokenAddress = tokenFamily ? adapters[tokenFamily]?.getAddress() : undefined;
  const xmr = useXmrStatus(supported?.family === 'xmr' ? adapters.xmr : null);
  const xmrRunning = xmr.status?.running ?? false;
  const xmrWasRunning = useRef(false);
  useEffect(() => {
    if (xmrWasRunning.current && !xmrRunning) pf.refresh();
    xmrWasRunning.current = xmrRunning;
  }, [xmrRunning]);

  // Coin light: the coin's colour pulled a little toward the UI grey, so dark coins stay legible.
  const c = coinTint(color, 0.95);
  const isBtc = supported?.family === 'btc' && supported.kind === 'native';
  const locks = useBtcLocks();
  const lockedSats = isBtc ? locks.status?.lockedSats ?? 0 : 0;
  const lockedUnits = BigInt(Math.max(0, Math.round(lockedSats)));
  const heldLocks = (locks.status?.locks ?? []).filter((l) => isHeld(l.status));
  const nextLock = heldLocks.filter((l) => l.status === 'locked' || l.status === 'confirming').sort((a, b) => a.t - b.t)[0];
  const available = holding?.amount ?? 0n;
  const totalAmount = available + (isBtc ? lockedUnits : 0n);
  const unitPrice = price?.price ?? null;
  const fiatOf = (amount: bigint, decimals: number) => (unitPrice === null ? null : (Number(amount) / 10 ** decimals) * unitPrice);
  const totalFiat = supported ? (lockedSats > 0 ? fiatOf(totalAmount, supported.decimals) : holding?.value ?? null) : null;
  const lockedFiat = supported && lockedSats > 0 ? fiatOf(lockedUnits, 8) ?? 0 : 0;
  const shareOf = totalFiat !== null && pf.total + lockedFiat > 0 ? (totalFiat / (pf.total + lockedFiat)) * 100 : (holding?.share ?? 0) * 100;
  const units = { d: t('lock.day'), h: t('lock.hour'), m: t('lock.minute') };

  // Previous / next among the assets the wallet holds (same order as the Portfolio).
  const held = pf.holdings.filter((h) => h.amount > 0n);
  const at = supported ? held.findIndex((h) => h.asset.id === supported.id) : -1;
  const prev = held.length > 1 || (held.length === 1 && at < 0) ? held[at < 0 ? held.length - 1 : (at - 1 + held.length) % held.length] : undefined;
  const next = held.length > 1 || (held.length === 1 && at < 0) ? held[at < 0 ? 0 : (at + 1) % held.length] : undefined;

  const [stageRef, stageW] = useWidth<HTMLDivElement>();
  const W = Math.min(1200, stageW);
  const ringSize = W >= 1000 ? 250 : 220;
  const segs: Seg[] =
    supported && lockedSats > 0
      ? [{ color: color ?? '#8fcaff', part: Number(available) }, { color: '#cfe7ff', part: lockedSats, ice: true }]
      : [{ color: color ?? '#8fcaff', part: 1, mute: !supported || available === 0n }];
  const notes: Note[] = [];
  if (supported && holding) {
    notes.push({
      seg: 0,
      side: 'L',
      dot: c,
      node: (
        <Side side="L" icon={<span className="block size-[9px] rounded-[2px]" style={{ background: c, boxShadow: `0 0 8px ${c}` }} />}>
          <span className="text-[13.5px] font-semibold">{t('portfolio.available')}</span>
          <span className="figure text-[12.5px] text-mute">
            <span style={hideBalances ? undefined : GLOW(c)}>{hideBalances ? HIDDEN : fmtCrypto(available, supported.decimals, supported.symbol)}</span>
            {holding.value !== null && <> · {hideBalances ? HIDDEN : fmtFiat(holding.value, cur)}</>}
          </span>
        </Side>
      ),
    });
  }
  if (supported && lockedSats > 0) {
    notes.push({
      seg: 1,
      side: 'R',
      node: (
        <button type="button" aria-label={t('lock.lineAria')} onClick={() => navigate({ name: 'btcLocks' })} className="press text-left">
          <Side side="R" icon={<IceSquare size={10} />}>
            <span className="text-[13.5px] font-semibold">{nextLock ? t('portfolio.lockedUntil', { date: unlockUtc(nextLock.t, intlLocale()) }) : t('portfolio.lockReady')}</span>
            <span className="figure text-[12.5px] text-mute">
              {hideBalances ? HIDDEN : fmtCrypto(lockedUnits, 8, 'BTC')}
              {nextLock && <> · {t('lock.leftAfter', { time: lockTimeLeft(nextLock.secsLeft, units) })}</>}
              {heldLocks.length > 1 && <> · {t('portfolio.lockMany', { n: heldLocks.length })}</>}
            </span>
          </Side>
        </button>
      ),
    });
  }

  const swapOk = !!supported && canSwapFrom(findChain(network, supported.chainKey), network);
  const stakeBlocked = !!activeWatch || (!!activeHw && !!stakeChain && !HW_STAKE[activeHw.device].includes(stakeChain));
  const ROW = 'flex h-9 items-center justify-between gap-3 border-t border-white/[.06] text-[13px]';

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto scroll-thin">
      <CoinGlow color={color ?? '#7cc4ff'} top={0} width={980} height={460} />
      <section className="relative flex min-h-full flex-col">
        {prev && (
          <button type="button" aria-label={t('portfolio.prevAsset', { name: prev.asset.name })} onClick={() => navigate({ name: 'asset', id: prev.asset.id })} className="press absolute top-[166px] left-8 z-10 flex items-center gap-2 text-[12.5px] text-faint transition-colors hover:text-text2">
            <span className="text-[15px]">‹</span> {prev.asset.name}
          </button>
        )}
        {next && (
          <button type="button" aria-label={t('portfolio.nextAsset', { name: next.asset.name })} onClick={() => navigate({ name: 'asset', id: next.asset.id })} className="press absolute top-[166px] right-8 z-10 flex items-center gap-2 text-[12.5px] text-faint transition-colors hover:text-text2">
            {next.asset.name} <span className="text-[15px]">›</span>
          </button>
        )}

        <div ref={stageRef} className="mt-5 w-full">
          {W > 0 && (
            <Annotated W={W} H={300} size={ringSize} segs={segs} notes={W >= 960 ? notes : []} halo={color ?? '#7cc4ff'}>
              <CoinIcon glyph={glyph} color={color} symbol={symbol} id={supported?.id ?? `cg:${coinId}`} chain={supported?.chainKey} size={Math.round(ringSize * 0.25)} />
            </Annotated>
          )}
        </div>

        <div className="mt-3 flex flex-col items-center px-8">
          <h1 className={cn(LABEL, 'm-0')}>{name}</h1>
          {supported ? (
            <>
              <span key={hideBalances ? 'h' : totalAmount.toString()} className="fade-in mt-3 text-[52px] leading-none" style={{ ...THIN, ...(holding && !hideBalances ? BIG(c) : {}) }}>
                {hideBalances ? HIDDEN : holding ? (
                  <>
                    {fmtCrypto(totalAmount, supported.decimals)}
                    <span className="ml-3 text-[22px]">{supported.symbol}</span>
                  </>
                ) : (
                  '—'
                )}
              </span>
              <span className="figure mt-3 text-[13.5px] text-text2">
                {hideBalances ? HIDDEN : totalFiat !== null ? fmtFiat(totalFiat, cur) : t('portfolio.priceUnavailable')}
                {!hideBalances && totalFiat !== null && <span className="text-faint"> · {t('portfolio.shareOfPortfolio', { share: fmtNumber(shareOf, 0) })}</span>}
              </span>
              <div role="group" aria-label={t('portfolio.assetActions')} className="mt-5 flex flex-wrap items-center justify-center gap-3">
                <CoinRound
                  c={c}
                  aria-label={t('shell.swap')}
                  disabled={!!activeWatch || !swapOk}
                  title={activeWatch ? t('watch.noSign') : !swapOk ? t('portfolio.swapUnavailable', { name: supported.name }) : t('shell.swap')}
                  onClick={() => navigate({ name: 'swap', sellAssetId: supported.id })}
                >
                  <IconSwap size={18} sw={2.1} />
                </CoinRound>
                <CoinPill c={c} disabled={supported.readOnly || !!activeWatch} title={activeWatch ? t('watch.noSign') : undefined} onClick={() => navigate({ name: 'send', assetId: supported.id })}>
                  <IconUp size={17} sw={2.2} /> {t('common.send')}
                </CoinPill>
                <CoinPill c={c} onClick={() => navigate({ name: 'receive', family: supported.family })}>
                  <IconDown size={17} sw={2.2} /> {t('common.receive')}
                </CoinPill>
                {address && supported.family !== 'ada' && (
                  <CoinRound c={c} aria-label={t('portfolio.qrCode')} title={t('portfolio.qrCode')} onClick={() => navigate({ name: 'receive', family: supported.family })}>
                    <IconQr size={18} sw={2} />
                  </CoinRound>
                )}
                {isBtc && (
                  <CoinRound c={c} aria-label={t('lock.title')} title={t('lock.title')} onClick={() => navigate({ name: 'btcLocks' })}>
                    <IconLock size={17} />
                  </CoinRound>
                )}
                {supported.kind === 'native' && stakeChain && (
                  <CoinRound
                    c={c}
                    aria-label="Staking"
                    disabled={stakeBlocked}
                    title={activeWatch ? t('watch.noSign') : stakeBlocked ? t('portfolio.stakingNoHw') : 'Staking'}
                    onClick={() => navigate({ name: 'staking', chain: stakeChain })}
                  >
                    <IconStake size={17} />
                  </CoinRound>
                )}
              </div>
            </>
          ) : (
            <Badge tone="ice" className="mt-3 h-6 px-2">
              {t('portfolio.unsupported')}
            </Badge>
          )}
        </div>

        <section className="mx-8 mt-auto flex flex-col pt-6 pb-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
            <span className={LABEL} title={t('portfolio.priceOf', { symbol, currency: cur })}>
              {t('portfolio.priceLabel')}
            </span>
            {price ? <SplitFiat value={price.price} currency={cur} tick className="fade-in text-[19px] leading-none" style={{ ...DISPLAY, fontWeight: 400, letterSpacing: '-0.03em' }} restClass="text-[13px] text-mute" /> : <Skeleton className="h-5 w-32 self-center" />}
            {changeAbs !== null && change !== null && (
              <span key={period} title={`${changeAbs >= 0 ? '+' : '−'}${fmtFiat(Math.abs(changeAbs), cur)}`} className={cn('fade-in figure text-[12.5px] font-medium', trendColor(change))}>
                {fmtPct(change)} {t(`portfolio.periodLabel${shown}`)}
              </span>
            )}
            <span className="ml-auto self-center">
              <Segmented label={t('portfolio.period')} value={shown} onChange={setPeriod} accent={c} items={coinPeriods(coinId).map((p) => ({ id: p, label: t(`portfolio.period${p}`) }))} />
            </span>
          </div>
          <div className="mt-1 flex h-[170px] flex-col justify-end">
            {values.length > 1 ? (
              <SmoothChart
                key={period}
                revealKey={chart.partial ? 'partial' : 'full'}
                values={values}
                times={times}
                height={170}
                stroke={c}
                glow
                defaultPoint="none"
                ariaLabel={t('portfolio.priceChartAria', { name })}
                padTop={70}
                padBottom={4}
                renderTooltip={(i) => ({ label: fmtChartTime(points[i]?.[0] ?? Date.now(), Date.now(), spanMs), value: fmtFiat(values[i] ?? 0, cur) })}
              />
            ) : chart.error ? (
              <ErrorLine className="pb-8" onRetry={chart.reload} error={chart.error}>
                {t('portfolio.chartError', { error: chart.error.message })}
              </ErrorLine>
            ) : (
              <Skeleton className="h-[150px] w-full" />
            )}
          </div>
        </section>
      </section>

      <div className="relative mx-8 mt-6 mb-10 flex flex-col gap-5">
        {tokenFamily && tokenAddress && <ReceivedTokens family={tokenFamily} address={tokenAddress} hidden={hideBalances} />}
        <div className="flex gap-5 max-[1100px]:flex-col">
          {/* Price-only assets have no account here: no activity card. */}
          {supported && (
            <Glass className="rise flex min-w-0 flex-1 flex-col self-start overflow-hidden rounded-[20px] max-[1100px]:self-stretch" style={idx(1)}>
              <div className="flex h-12 shrink-0 items-center justify-between px-5">
                <span className={LABEL}>{t('portfolio.activityOf', { symbol })}</span>
                <button type="button" onClick={() => navigate({ name: 'history' })} className="text-[12.5px] font-medium text-ice hover:underline">
                  {t('portfolio.seeAll')}
                </button>
              </div>
              <div>
                {activity.length === 0 && supported.family === 'dot' && history.data?.dotHistory === 'unavailable' ? (
                  <EmptyState title={t('portfolio.dotNoHistoryTitle')}>{network === 'testnet' ? t('portfolio.dotNoHistoryTestnet') : t('portfolio.dotNoHistory')}</EmptyState>
                ) : activity.length === 0 && chainPending && !chainKnown ? (
                  // No answer yet: a neutral line, never « No activity » before the first answer.
                  <div className="flex items-center gap-2 px-5 py-5 text-[12.5px] text-mute" role="status">
                    {spinWindow && <Spinner className="size-3.5 text-mute" />}
                    {t('portfolio.loadingActivity')}
                  </div>
                ) : activity.length === 0 ? (
                  <EmptyState title={t('portfolio.noActivity')}>{t('portfolio.noActivityHint')}</EmptyState>
                ) : (
                  <div className="stagger">{activity.map((e, i) => <HistoryRow key={e.id} i={i} e={e} compact price={price?.price ?? null} currency={cur} hidden={hideBalances} />)}</div>
                )}
              </div>
            </Glass>
          )}

          <div className={cn('rise flex shrink-0 flex-col gap-5', supported ? 'w-[clamp(280px,34%,360px)] max-[1100px]:w-full' : 'flex-1')} style={idx(2)}>
            <Glass className="flex flex-col gap-2 rounded-[20px] px-5 py-4">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pb-1">
                <button type="button" aria-label={t('common.back')} title={t('common.back')} onClick={back} className="press -ml-1 grid size-7 place-items-center rounded-ctl text-faint hover:text-text">
                  <IconBack size={14} />
                </button>
                <span className={LABEL}>{supported ? t('portfolio.yourBalance') : name}</span>
                <span className="text-[11px] font-medium tracking-[0.12em] text-faint">{symbol}</span>
                {coin?.rank && <span className="figure text-[11px] text-faint">{t('portfolio.rank', { rank: coin.rank })}</span>}
                <button type="button" aria-label={fav ? t('portfolio.removeFavorite') : t('portfolio.addFavorite')} aria-pressed={fav} onClick={() => toggle(coinId)} className={cn('press ml-auto flex size-7 items-center justify-center rounded-ctl', fav ? 'text-ice' : 'text-faint hover:text-text2')}>
                  <span key={String(fav)} className={fav ? 'pop-in inline-flex' : 'inline-flex'}>
                    <IconStar size={15} filled={fav} />
                  </span>
                </button>
              </div>
              {supported && <AccountPicker family={supported.family} />}
              {supported ? (
                <>
                  <div className={ROW}>
                    <span className="text-mute">{t('portfolio.available')}</span>
                    <span className="figure font-medium" style={hideBalances || !holding || available === 0n ? undefined : GLOW(c)}>
                      {hideBalances ? HIDDEN : holding ? fmtCrypto(available, supported.decimals, supported.symbol) : '—'}
                    </span>
                  </div>
                  <div className={ROW}>
                    <span className="text-mute">{t('portfolio.balanceDetails')}</span>
                    <span className="figure text-text2">
                      {hideBalances ? HIDDEN : holding?.value !== null && holding?.value !== undefined ? t('portfolio.valueShare', { value: fmtFiat(holding.value, cur), share: fmtNumber(holding.share * 100, 0) }) : t('portfolio.priceUnavailable')}
                    </span>
                  </div>
                  {isBtc && <LockedLine className="border-t border-white/[.06] pt-2.5" />}
                  <AssetGains gains={gains.byAsset.get(supported.id)} symbol={supported.symbol} />
                  {accountRows.length > 1 && (
                    <div className="mt-2 flex flex-col">
                      <span className={cn(LABEL, 'pb-2')}>{t('portfolio.perAccount')}</span>
                      {accountRows.map((h) => {
                        const active = h.account?.index === selectedAccounts[supported.family];
                        return (
                          <button key={h.key} type="button" aria-pressed={active} onClick={() => h.account && selectChainAccount(h.account.family, h.account.index)} className={cn(ROW, 'text-left hover:text-text')}>
                            <span className={cn('flex min-w-0 items-center gap-2', active ? 'text-text' : 'text-text2')}>
                              <span className={cn('size-[5px] shrink-0', active ? 'bg-ice shadow-[0_0_8px_#7cc4ff]' : 'bg-faint')} />
                              <span className="truncate">{h.account?.name}</span>
                            </span>
                            <span className={cn('figure', h.amount > 0n ? 'font-medium' : 'text-mute')}>{hideBalances ? HIDDEN : fmtCrypto(h.amount, supported.decimals)}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {perNetwork.length > 0 && (
                    <div className="mt-2 flex flex-col">
                      <span className={cn(LABEL, 'pb-2')}>{t('portfolio.perNetwork')}</span>
                      {perNetwork.map(({ chain, asset: a, amount }) => (
                        <div key={chain.key} className={ROW}>
                          <span className="flex items-center gap-2 text-text2">
                            <span className={cn('size-[5px]', a && amount && amount > 0n ? 'bg-ice shadow-[0_0_8px_#7cc4ff]' : 'bg-faint')} />
                            {chain.name}
                          </span>
                          <span className={cn('figure', a && amount && amount > 0n ? 'font-medium' : 'text-mute')}>{!a ? t('portfolio.notListed') : amount === null ? '—' : hideBalances ? HIDDEN : `${fmtCrypto(amount, a.decimals)}${chain.phase === 2 ? ` · ${t('portfolio.phase2')}` : ''}`}</span>
                        </div>
                      ))}
                      {network === 'testnet' && <span className="pt-2 text-[12px] text-faint">{t('portfolio.l2OnMainnet')}</span>}
                    </div>
                  )}
                  {supported.family === 'ada' && <CardanoTokensPanel account={adaAccount.data} hidden={hideBalances} />}
                  {supported.family === 'hbar' && hbarAccount.data && (
                    <div className="mt-2 flex flex-col gap-1 border-t border-white/[.06] pt-3 text-[13px]">
                      <span className={LABEL}>{t('portfolio.hbarAccount')}</span>
                      {hbarAccount.data.exists ? <span className="font-mono text-text2">{hbarAccount.data.accountIdChecksum ?? hbarAccount.data.accountId}</span> : <span className="text-[12px] text-warn">{t('portfolio.hbarNoAccount')}</span>}
                      {hbarAccount.data.hollow && <span className="text-[12px] text-mute">{t('portfolio.hbarHollow')}</span>}
                    </div>
                  )}
                  {supported.family === 'xmr' && (
                    <div className="mt-2 flex flex-col gap-2">
                      <XmrLockedNote status={xmr.status} hidden={hideBalances} />
                      <XmrSyncLine status={xmr.status} error={xmr.error} onRetry={xmr.sync} />
                    </div>
                  )}
                  {address && supported.family !== 'ada' && (
                    <div className="mt-1 flex items-center justify-between gap-2 border-t border-white/[.06] pt-3">
                      <AddressShort address={address} />
                      <GlassButton className="h-8 rounded-[10px] px-3 text-[12px] font-medium" onClick={() => navigate({ name: 'receive', family: supported.family })}>
                        {t('portfolio.qrCode')}
                      </GlassButton>
                    </div>
                  )}
                </>
              ) : (
                <EmptyState title={t('portfolio.assetUnsupported')}>{t('portfolio.unsupportedHint')}</EmptyState>
              )}
            </Glass>

            <Glass className="flex flex-col rounded-[20px] px-5 py-4">
              <span className={cn(LABEL, 'pb-3')}>{t('portfolio.market')}</span>
              {[
                [t('portfolio.high24h'), coin?.high24h !== null && coin?.high24h !== undefined ? fmtFiat(coin.high24h, cur) : '—', ''],
                [t('portfolio.low24h'), coin?.low24h !== null && coin?.low24h !== undefined ? fmtFiat(coin.low24h, cur) : '—', ''],
                [t('portfolio.change7d'), fmtPct(coin?.change7d), (coin?.change7d ?? 0) >= 0 ? 'text-up' : 'text-down'],
                [t('portfolio.change30d'), fmtPct(change30), (change30 ?? 0) >= 0 ? 'text-up' : 'text-down'],
              ].map(([k, v, tone]) => (
                <div key={k} className={ROW}>
                  <span className="text-mute">{k}</span>
                  <span className={cn('figure font-medium', v === '—' ? 'text-mute' : tone)}>{v}</span>
                </div>
              ))}
              {supported && findChain(network, supported.chainKey)?.network === 'testnet' && <p className="m-0 pt-3 text-[12px] leading-[1.5] text-faint">{t('portfolio.testnetPricesNote')}</p>}
            </Glass>
          </div>
        </div>
      </div>
    </div>
  );
}
