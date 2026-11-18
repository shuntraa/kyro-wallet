// SPDX-License-Identifier: GPL-3.0-or-later
// "Mes actifs" / "Marché · top 250" / "Favoris" lists.

import { useMemo, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { matchesCoinQuery } from '@kyro/chains';
import type { MarketCoin } from '@kyro/market';
import { getLang, type Currency } from '@kyro/shared';
import { cn } from '../lib/cn';
import { fiatSymbol, fmtCrypto, fmtFiat, fmtNumber, fmtPct, NNBSP } from '../lib/format';
import { getFavorites, setFavorites } from '../lib/storage';
import { withoutSmall } from '../lib/hideSmall';
import { useApp } from '../state/app';
import { usePortfolio, type Holding } from '../state/portfolio';
import { CoinIcon, EmptyState, ErrorLine, HIDDEN, trendColor, trendHex } from './kit';
import { GLASS_ROW, GLOW, Glass, Tabs, THIN, VaultRing } from './kyro';
import { GlassSearch, coinTint, useWidth } from './kyroParts';
import { Sparkline } from './charts';
import { useTorBlocked } from './Tor';
import { cbfPending, networkDown, serverDown, serverMissing, useCustomServer } from './ServerDown';
import { Menu } from './ui/menu';
import { Skeleton } from './ui/primitives';
import { IconChevronDown, IconChevronRight, IconInfo, IconStar } from './icons';
import { idx } from './motion';
import { getLanguage, t, useT } from '../i18n';

export type ListTab = 'mine' | 'market' | 'favorites';
type Sort = 'value' | 'change' | 'name';

const GRID = 'grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_104px_minmax(0,1.1fr)_120px] items-center gap-4';

export function useFavorites() {
  const [favs, setFavs] = useState<string[]>(() => getFavorites());
  const toggle = (id: string) => {
    setFavs((f) => {
      const next = f.includes(id) ? f.filter((x) => x !== id) : [...f, id];
      setFavorites(next);
      return next;
    });
  };
  return { favs, toggle };
}

export function AssetListsCard({ initialTab = 'mine', className, layout = 'list', title, extra }: { initialTab?: ListTab; className?: string; /** `tiles`: the Assets page grid for « Mes actifs ». */ layout?: 'list' | 'tiles'; /** Shown left of the tabs (the Assets page title). */ title?: ReactNode; /** Extra buttons right of the sort menu. */ extra?: ReactNode }) {
  const [tab, setTab] = useState<ListTab>(initialTab);
  const [sort, setSort] = useState<Sort>('value');
  const [query, setQuery] = useState('');
  const pf = usePortfolio();
  const { favs, toggle } = useFavorites();
  const { settings } = useApp();
  const mineCount = withoutSmall(pf.holdings.filter((h) => h.amount > 0n), settings.hideSmall).length;
  const tiles = layout === 'tiles';
  const { t } = useT();
  const sortLabel = (s: Sort) => (s === 'value' ? (tab === 'mine' ? t('portfolio.sortValue') : t('portfolio.sortMarketCap')) : s === 'change' ? t('portfolio.sortChange') : t('portfolio.sortName'));
  const body =
    tab === 'mine' ? (
      layout === 'tiles' ? <MineTiles sort={sort} query={query} /> : <Glass className="overflow-hidden rounded-[20px]"><MineList sort={sort} query={query} /></Glass>
    ) : (
      <Glass className="overflow-hidden rounded-[20px]">
        <MarketList sort={sort} query={query} favs={favs} toggle={toggle} onlyFavs={tab === 'favorites'} />
      </Glass>
    );

  return (
    <section aria-label={t('shell.assets')} className={cn('flex min-w-0 flex-col', className)}>
      <div className={cn('flex flex-wrap items-center gap-y-3', tiles ? 'pb-5' : 'gap-x-8 pb-4')}>
        {title}
        <span className={tiles ? 'ml-10' : undefined}>
        <Tabs<ListTab>
          label={t('portfolio.lists')}
          value={tab}
          onChange={setTab}
          items={[
            { id: 'mine', label: tiles ? t('portfolio.tabMine') : <>{t('portfolio.tabMine')} <span className="figure text-faint">{mineCount}</span></> },
            { id: 'market', label: t('portfolio.tabMarket') },
            { id: 'favorites', label: tiles ? t('portfolio.tabFavorites') : <>{t('portfolio.tabFavorites')} {favs.length > 0 && <span className="figure text-faint">{favs.length}</span>}</> },
          ]}
        />
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Menu<Sort>
            align="end"
            value={sort}
            onSelect={setSort}
            items={[
              { value: 'value', label: tab === 'mine' ? t('portfolio.sortValue') : t('portfolio.sortMarketCap') },
              { value: 'change', label: t('portfolio.sortChange24h') },
              { value: 'name', label: t('portfolio.sortName') },
            ]}
            trigger={
              <button type="button" className={cn('press flex h-9 items-center gap-1.5 rounded-[12px] px-3 text-[12.5px] hover:text-text', tiles ? 'text-faint' : cn('text-text2', GLASS_ROW))}>
                {sortLabel(sort)} <IconChevronDown size={14} />
              </button>
            }
          />
          {extra}
          <GlassSearch value={query} onChange={setQuery} placeholder={t('portfolio.searchPlaceholder')} label={t('portfolio.filter')} className="w-[220px]" />
        </div>
      </div>
      {body}
    </section>
  );
}

function filterHoldings(rows: Holding[], query: string): Holding[] {
  const q = query.trim().toLowerCase();
  return q ? rows.filter((h) => matchesCoinQuery(q, { name: h.asset.name, symbol: h.asset.symbol, coingeckoId: h.asset.coingeckoId })) : rows;
}

/** The chain problem of a row (after the automatic retries), as a short sentence, or null. */
function useRowProblem() {
  const pf = usePortfolio();
  const torBlocked = useTorBlocked(Object.values(pf.chainErrors).join(' ') || undefined);
  const { network } = useApp();
  const { t } = useT();
  const customServer = useCustomServer();
  return (chainKey: string): string | null => {
    const m = pf.chainErrors[chainKey];
    if (m === undefined) return null;
    if (torBlocked) return t('portfolio.rowWaitingTor');
    if (serverMissing(m)) return network === 'testnet' && chainKey === 'zcash' ? t('portfolio.zecTestnetNoServer') : t('portfolio.rowNoServer');
    if (serverDown(m, customServer(chainKey))) return t('portfolio.rowServerDown');
    if (networkDown(m, customServer(chainKey))) return t('portfolio.rowNetworkDown');
    if (cbfPending(m)) return t('portfolio.rowSyncingFilters');
    return t('portfolio.rowBalanceUnavailable');
  };
}

function kindTag(h: Holding): string {
  return h.asset.kind === 'erc20' ? ' · ERC-20' : h.asset.kind === 'spl' ? ' · SPL' : h.asset.kind === 'trc20' ? ' · TRC-20' : '';
}

function sortHoldings(rows: Holding[], sort: Sort): Holding[] {
  const r = [...rows];
  if (sort === 'name') r.sort((a, b) => a.asset.name.localeCompare(b.asset.name, getLanguage()));
  if (sort === 'change') r.sort((a, b) => (b.change24h ?? -999) - (a.change24h ?? -999));
  return r;
}

function MineList({ sort, query }: { sort: Sort; query: string }) {
  const pf = usePortfolio();
  const { t } = useT();
  const problem = useRowProblem();
  const { settings, hideBalances, navigate, selectChainAccount } = useApp();
  const cur = settings.currency;
  // One row per asset (every account added together); the accounts of a multi-account asset
  // unfold under it.
  // Réglages › Affichage: small holdings stay out, unless searched for.
  const rows = withoutSmall(filterHoldings(sortHoldings(pf.holdings, sort), query), settings.hideSmall, query);
  const byAsset = useMemo(() => {
    const m = new Map<string, Holding[]>();
    for (const h of pf.accountHoldings) if (h.account) m.set(h.asset.id, [...(m.get(h.asset.id) ?? []), h]);
    return m;
  }, [pf.accountHoldings]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  let i = 0;
  const line = (h: Holding, sub: boolean, accounts: number) => {
    const n = i++;
    const issue = problem(h.asset.chainKey);
    const c = coinTint(h.asset.color);
    return (
      <button
        key={h.key}
        type="button"
        style={idx(n)}
        onClick={() => {
          if (h.account) selectChainAccount(h.account.family, h.account.index);
          navigate({ name: 'asset', id: h.asset.id });
        }}
        className={cn(GRID, 'group w-full border-t border-white/[.05] px-6 text-left transition-colors duration-150 hover:bg-white/[.03]', sub ? 'h-12 bg-black/10' : 'h-16')}
      >
        <span className={cn('flex min-w-0 items-center gap-3.5', sub && 'pl-[48px]')}>
          {!sub && <CoinIcon asset={h.asset} size={34} />}
          <span className="flex min-w-0 flex-col leading-tight">
            {sub ? (
              <span className="truncate text-[13px] text-text2">{h.account?.name}</span>
            ) : (
              <>
                <span className="truncate text-[14px] font-semibold">{h.asset.name}</span>
                <span className="truncate text-[12px] text-faint">
                  {h.asset.symbol}
                  {kindTag(h)}
                  {accounts > 1 ? ` · ${t('portfolio.accountCount', { n: accounts })}` : ''}
                </span>
              </>
            )}
          </span>
        </span>
        {sub ? (
          <span />
        ) : (
          <span className="figure flex flex-col leading-tight">
            <span className="text-[13.5px] text-text2">{h.price !== null ? fmtFiat(h.price, cur) : '—'}</span>
            <span className={cn('text-[12px]', trendColor(h.change24h))}>{fmtPct(h.change24h)}</span>
          </span>
        )}
        {sub ? <span /> : h.spark.length > 1 ? <Sparkline values={h.spark} color={c} glow /> : <span className="text-[12px] text-faint">—</span>}
        <span className="figure flex items-center justify-end gap-2.5">
          {issue && (
            <span data-tip={issue} aria-label={issue} className="kyro-tip size-[22px] place-items-center rounded-full bg-[rgba(124,196,255,.1)] text-ice/85 shadow-[0_0_10px_rgba(124,196,255,.3)] ring-1 ring-[rgba(124,196,255,.35)] transition-[color,box-shadow] hover:text-ice hover:shadow-[0_0_14px_rgba(124,196,255,.55)]">
              <IconInfo size={12} />
            </span>
          )}
          <span className="flex flex-col items-end leading-tight">
            <span key={hideBalances ? 'h' : h.amount.toString()} className={cn('fade-in', sub ? 'text-[13px]' : 'text-[14px] font-medium', h.amount === 0n && 'text-mute')} style={h.amount > 0n && !hideBalances ? GLOW(c) : undefined}>
              {hideBalances ? HIDDEN : fmtCrypto(h.amount, h.asset.decimals, h.asset.symbol)}
            </span>
            <span className="text-[12px] text-mute">{hideBalances ? HIDDEN : h.value !== null ? fmtFiat(h.value, cur) : '—'}</span>
          </span>
        </span>
        <span className="flex items-center gap-2.5">
          <span className="h-[3px] w-16 overflow-hidden rounded-full bg-white/[.07]">
            <motion.span className="block h-full rounded-full" style={{ background: c, boxShadow: `0 0 8px ${c}88` }} initial={{ width: 0 }} animate={{ width: `${Math.round(h.share * 100)}%` }} transition={{ duration: 0.5, delay: 0.1 + n * 0.03, ease: [0.22, 1, 0.36, 1] }} />
          </span>
          <span className="figure text-[12px] text-mute">{fmtPct(h.share * 100, { sign: false, decimals: 0 })}</span>
        </span>
      </button>
    );
  };
  return (
    <div className="flex flex-col">
      <div className={cn(GRID, 'h-10 shrink-0 px-6 text-[10.5px] font-medium tracking-[0.14em] whitespace-nowrap text-faint uppercase')}>
        <span>{t('portfolio.colAsset')}</span>
        <span>{t('portfolio.colPrice24h')}</span>
        <span>{t('portfolio.col7d')}</span>
        <span className="text-right">{t('portfolio.colBalance')}</span>
        <span>{t('portfolio.colShare')}</span>
      </div>
      <div className="stagger">
        {rows.map((h) => {
          const subs = byAsset.get(h.asset.id) ?? [];
          if (subs.length < 2) return line(h, false, 1);
          const isOpen = open.has(h.asset.id);
          return (
            <div key={h.key} className="relative">
              {line(h, false, subs.length)}
              <button
                type="button"
                aria-expanded={isOpen}
                aria-label={t('portfolio.showAccounts')}
                onClick={() => toggle(h.asset.id)}
                className="absolute top-[22px] left-1 flex size-5 items-center justify-center rounded-ctl text-mute hover:bg-raised hover:text-text"
              >
                <IconChevronRight size={13} className={cn('transition-transform duration-150', isOpen && 'rotate-90')} />
              </button>
              {isOpen && subs.map((s) => line(s, true, 1))}
            </div>
          );
        })}
        {rows.length === 0 && query.trim() !== '' && <EmptyState title={t('portfolio.noResults')}>{t('portfolio.noResultsHint')}</EmptyState>}
        {pf.balancesLoaded && pf.holdings.every((h) => h.amount === 0n) && (
          <EmptyState title={t('portfolio.emptyVault')} action={<button type="button" onClick={() => navigate({ name: 'receive' })} className="text-[13px] font-semibold text-ice hover:underline">{t('portfolio.receiveFunds')}</button>}>
            {t('portfolio.emptyVaultHint')}
          </EmptyState>
        )}
      </div>
    </div>
  );
}

/** Assets page, « Mes actifs »: one tile per asset, lit in the coin's colour; empty ones dimmed. */
function MineTiles({ sort, query }: { sort: Sort; query: string }) {
  const pf = usePortfolio();
  const { t } = useT();
  const problem = useRowProblem();
  const { settings, hideBalances, navigate, selectChainAccount, selectedAccounts } = useApp();
  const cur = settings.currency;
  const all = withoutSmall(filterHoldings(sortHoldings(pf.holdings, sort), query), settings.hideSmall, query);
  // Assets with a balance first, the others dimmed after them (same order inside each group).
  const rows = [...all.filter((h) => h.amount > 0n), ...all.filter((h) => h.amount === 0n)];
  const byAsset = useMemo(() => {
    const m = new Map<string, Holding[]>();
    for (const h of pf.accountHoldings) if (h.account) m.set(h.asset.id, [...(m.get(h.asset.id) ?? []), h]);
    return m;
  }, [pf.accountHoldings]);
  const empty = pf.balancesLoaded && pf.holdings.every((h) => h.amount === 0n);
  return (
    <div className="flex flex-col gap-4">
      {empty && (
        <EmptyState title={t('portfolio.emptyVault')} action={<button type="button" onClick={() => navigate({ name: 'receive' })} className="text-[13px] font-semibold text-ice hover:underline">{t('portfolio.receiveFunds')}</button>}>
          {t('portfolio.emptyVaultHint')}
        </EmptyState>
      )}
      {rows.length === 0 && query.trim() !== '' && <EmptyState title={t('portfolio.noResults')}>{t('portfolio.noResultsHint')}</EmptyState>}
      <div className="stagger grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
        {rows.map((h, n) => {
          const held = h.amount > 0n;
          const c = coinTint(h.asset.color, 0.96);
          const issue = problem(h.asset.chainKey);
          const subs = byAsset.get(h.asset.id) ?? [];
          const open = () => navigate({ name: 'asset', id: h.asset.id });
          const head = (
            <span className="pointer-events-none relative flex items-center gap-3">
              <VaultRing size={46} segs={[{ color: h.asset.color ?? '#8fcaff', part: 1 }]} halo={h.asset.color ?? '#7cc4ff'} glow={held}>
                <CoinIcon asset={h.asset} size={21} />
              </VaultRing>
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-[14px] font-semibold">{h.asset.name}</span>
                <span className="truncate text-[11.5px] text-faint">
                  {h.asset.symbol}
                  {kindTag(h)}
                  {subs.length > 1 ? ` · ${t('portfolio.accountCount', { n: subs.length })}` : ''}
                </span>
              </span>
              {held && <span className={cn('figure ml-auto self-start text-[11.5px] font-medium', trendColor(h.change24h))}>{fmtPct(h.change24h)}</span>}
            </span>
          );
          if (!held) {
            return (
              <div key={h.key} style={{ ...idx(n), ['--c' as string]: h.asset.color ?? '#7cc4ff' }} className={cn('coin-tile relative flex min-h-[172px] flex-col overflow-hidden rounded-[22px] p-4', GLASS_ROW)}>
                {/* An empty asset keeps its colour (a new wallet is not a grey page); only its figure is faint. */}
                <span aria-hidden="true" className="pointer-events-none absolute -top-16 -left-10 size-48 rounded-full" style={{ background: `radial-gradient(circle, ${h.asset.color ?? '#7cc4ff'}1c, transparent 70%)` }} />
                <button type="button" onClick={open} aria-label={h.asset.name} className="absolute inset-0 rounded-[22px]" />
                {head}
                <span className="pointer-events-none relative mt-3.5 text-[20px] leading-none text-faint" style={THIN}>
                  {hideBalances ? HIDDEN : `0 ${h.asset.symbol}`}
                </span>
                {issue && (
                  <span className="pointer-events-none relative mt-2 flex items-center gap-1.5 text-[11.5px] text-faint">
                    <IconInfo size={12} /> {issue}
                  </span>
                )}
                <button type="button" onClick={() => navigate({ name: 'receive', family: h.asset.family })} className="relative mt-auto self-start pt-4 text-[12px] text-mute hover:text-text">
                  {t('common.receive')} →
                </button>
              </div>
            );
          }
          return (
            <Glass key={h.key} className="coin-tile relative flex min-h-[172px] flex-col overflow-hidden rounded-[22px] p-4" style={{ ...idx(n), ['--c' as string]: h.asset.color ?? '#7cc4ff' }}>
              <span aria-hidden="true" className="pointer-events-none absolute -top-16 -left-10 size-48 rounded-full" style={{ background: `radial-gradient(circle, ${h.asset.color ?? '#7cc4ff'}30, transparent 70%)` }} />
              <button type="button" onClick={open} aria-label={h.asset.name} className="absolute inset-0 rounded-[22px]" />
              {head}
              <span key={hideBalances ? 'h' : h.amount.toString()} className="fade-in pointer-events-none relative mt-3.5 truncate text-[20px] leading-tight" style={{ ...THIN, ...(hideBalances ? {} : GLOW(c)) }}>
                {hideBalances ? HIDDEN : fmtCrypto(h.amount, h.asset.decimals, h.asset.symbol)}
              </span>
              <span className="figure pointer-events-none relative mt-1.5 flex items-center gap-1.5 text-[12.5px] text-text2">
                {hideBalances ? HIDDEN : h.value !== null ? fmtFiat(h.value, cur) : '—'}
                {issue && (
                  <span data-tip={issue} aria-label={issue} className="kyro-tip pointer-events-auto size-[18px] place-items-center rounded-full bg-[rgba(124,196,255,.1)] text-ice/85 shadow-[0_0_10px_rgba(124,196,255,.3)] ring-1 ring-[rgba(124,196,255,.35)] transition-[color,box-shadow] hover:text-ice hover:shadow-[0_0_14px_rgba(124,196,255,.55)]">
                    <IconInfo size={11} />
                  </span>
                )}
              </span>
              {subs.length > 1 && (
                <span className="relative mt-2 flex flex-col">
                  {subs.map((s) => {
                    const active = s.account?.index === selectedAccounts[s.asset.family];
                    return (
                      <button
                        key={s.key}
                        type="button"
                        onClick={() => {
                          if (s.account) selectChainAccount(s.account.family, s.account.index);
                          open();
                        }}
                        className="flex h-6 items-center justify-between gap-2 text-[11.5px] text-mute hover:text-text"
                      >
                        <span className={cn('truncate', active && 'text-text2')}>{s.account?.name}</span>
                        <span className="figure">{hideBalances ? HIDDEN : fmtCrypto(s.amount, s.asset.decimals)}</span>
                      </button>
                    );
                  })}
                </span>
              )}
              <span className="pointer-events-none relative mt-auto pt-3">{h.spark.length > 1 ? <TileSpark values={h.spark} color={c} /> : null}</span>
            </Glass>
          );
        })}
      </div>
    </div>
  );
}

/** Sparkline across the whole width of a tile. */
function TileSpark({ values, color }: { values: number[]; color: string }) {
  const [ref, w] = useWidth<HTMLSpanElement>();
  return (
    <span ref={ref} className="block h-10 w-full">
      {w > 0 && <Sparkline values={values} color={color} width={w} height={40} glow fill />}
    </span>
  );
}

function MarketList({ sort, query, favs, toggle, onlyFavs }: { sort: Sort; query: string; favs: string[]; toggle: (id: string) => void; onlyFavs: boolean }) {
  const pf = usePortfolio();
  const { settings, navigate } = useApp();
  const { t, lang } = useT();
  const rows = useMemo(() => {
    let r: MarketCoin[] = pf.markets ?? [];
    if (onlyFavs) r = r.filter((c) => favs.includes(c.id));
    const q = query.trim().toLowerCase();
    if (q) r = r.filter((c) => matchesCoinQuery(q, { name: c.name, symbol: c.symbol, coingeckoId: c.id }));
    r = [...r];
    if (sort === 'name') r.sort((a, b) => a.name.localeCompare(b.name, getLanguage()));
    else if (sort === 'change') r.sort((a, b) => (b.change24h ?? -999) - (a.change24h ?? -999));
    else r.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
    return r;
  }, [pf.markets, onlyFavs, favs, query, sort, lang]);
  const MG = 'grid grid-cols-[28px_minmax(0,1.6fr)_minmax(0,1fr)_104px_minmax(0,1fr)_36px] items-center gap-4';

  if (!pf.markets) {
    return pf.marketError ? (
      <ErrorLine className="px-5 py-6" onRetry={pf.refresh} error={pf.marketError}>
        {t('portfolio.marketUnavailable', { error: pf.marketError })}
      </ErrorLine>
    ) : (
      <div className="flex flex-col gap-3 p-5">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
    );
  }
  return (
    <div className="flex flex-col">
      <div className={cn(MG, 'h-10 shrink-0 border-b border-white/[.05] px-6 text-[10.5px] font-medium tracking-[0.14em] whitespace-nowrap text-faint uppercase')}>
        <span>#</span>
        <span>{t('portfolio.colAsset')}</span>
        <span>{t('portfolio.colPrice24h')}</span>
        <span>{t('portfolio.col7d')}</span>
        <span className="text-right">{t('portfolio.colMarketCap')}</span>
        <span />
      </div>
      <div className="stagger">
        {rows.length === 0 && (
          <EmptyState title={onlyFavs ? t('portfolio.noFavorites') : t('portfolio.noResults')}>{onlyFavs ? t('portfolio.noFavoritesHint') : t('portfolio.noResultsHint')}</EmptyState>
        )}
        {rows.map((c, i) => {
          const fav = favs.includes(c.id);
          return (
            <div key={c.id} style={idx(i)} className={cn(MG, 'h-[60px] border-t border-white/[.05] px-6 transition-colors duration-150 first:border-t-0 hover:bg-white/[.03]')}>
              <span className="text-[13px] text-faint">{c.rank ?? '—'}</span>
              <button type="button" onClick={() => navigate({ name: 'asset', id: `cg:${c.id}` })} className="flex min-w-0 items-center gap-3 text-left">
                <CoinIcon symbol={c.symbol} id={`cg:${c.id}`} size={32} />
                <span className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate text-[14px] font-semibold">{c.name}</span>
                  <span className="text-[12px] text-faint">{c.symbol}</span>
                </span>
              </button>
              <span className="figure flex flex-col leading-tight">
                <span className="text-[13.5px] text-text2">{fmtFiat(c.price, settings.currency)}</span>
                <span className={cn('text-[12px]', trendColor(c.change24h))}>{fmtPct(c.change24h)}</span>
              </span>
              {c.sparkline7d.length > 1 ? <Sparkline values={c.sparkline7d} color={trendHex(c.change7d)} /> : <span />}
              <span className="figure text-right text-[13px] text-text2">{c.marketCap !== null ? compactFiat(c.marketCap, settings.currency) : '—'}</span>
              <button type="button" aria-label={fav ? t('portfolio.removeFavorite') : t('portfolio.addFavorite')} aria-pressed={fav} onClick={() => toggle(c.id)} className={cn('press flex size-8 items-center justify-center rounded-ctl', fav ? 'text-ice' : 'text-faint hover:text-text2')}>
                <span key={String(fav)} className={fav ? 'pop-in inline-flex' : 'inline-flex'}>
                  <IconStar size={16} filled={fav} />
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function compactFiat(v: number, cur: Currency): string {
  const raw = fiatSymbol(cur);
  const sym = /^\p{L}/u.test(raw) ? (getLang() === 'fr' ? `${NNBSP}${raw}` : `${raw}${NNBSP}`) : raw;
  if (v >= 1e12) return t('portfolio.trillions', { n: fmtNumber(v / 1e12, 2), sym });
  if (v >= 1e9) return t('portfolio.billions', { n: fmtNumber(v / 1e9, 1), sym });
  if (v >= 1e6) return t('portfolio.millions', { n: fmtNumber(v / 1e6, 1), sym });
  return fmtFiat(v, cur, { decimals: 0 });
}
