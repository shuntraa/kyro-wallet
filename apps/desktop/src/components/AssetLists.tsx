// SPDX-License-Identifier: GPL-3.0-or-later
// "Mes actifs" / "Marché · top 250" / "Favoris" lists.

import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { WATCH_ONLY_CHAINS } from '@kyro/chains';
import type { MarketCoin } from '@kyro/market';
import { cn } from '../lib/cn';
import { fmtCrypto, fmtFiat, fmtNumber, fmtPct } from '../lib/format';
import { getFavorites, setFavorites } from '../lib/storage';
import { useApp } from '../state/app';
import { usePortfolio, type Holding } from '../state/portfolio';
import { CoinIcon, EmptyState, ErrorLine, HIDDEN, trendColor, trendHex } from './kit';
import { Sparkline } from './charts';
import { useTorBlocked } from './Tor';
import { ServerDownLine, ServerMissingLine, cbfPending, serverDown, serverMissing } from './ServerDown';
import { findChain } from '@kyro/chains';
import { Menu } from './ui/menu';
import { Badge, Skeleton } from './ui/primitives';
import { IconChevronDown, IconSearch, IconStar } from './icons';
import { idx } from './motion';

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

export function AssetListsCard({ initialTab = 'mine', className }: { initialTab?: ListTab; className?: string }) {
  const [tab, setTab] = useState<ListTab>(initialTab);
  const [sort, setSort] = useState<Sort>('value');
  const [query, setQuery] = useState('');
  const pf = usePortfolio();
  const { favs, toggle } = useFavorites();
  const mineCount = pf.holdings.filter((h) => h.amount > 0n).length;

  return (
    <section aria-label="Actifs" className={cn('flex min-w-0 flex-col overflow-hidden rounded-panel border border-line bg-card', className)}>
      <div className="flex h-[52px] shrink-0 items-center justify-between gap-3 border-b border-line px-5">
        <div role="tablist" aria-label="Listes" className="flex h-[52px] gap-[22px]">
          {(
            [
              ['mine', <>Mes actifs <span className="font-medium text-mute">{mineCount}</span></>],
              ['market', 'Marché · top 250'],
              ['favorites', <>Favoris {favs.length > 0 && <span className="font-medium text-mute">{favs.length}</span>}</>],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn('relative h-[52px] text-[14px] transition-colors duration-150', tab === k ? 'font-medium text-text' : 'font-normal text-mute hover:text-text2')}
            >
              {label}
              {tab === k && <motion.span layoutId="asset-tab" aria-hidden="true" className="absolute right-0 -bottom-px left-0 h-[2px] rounded-full bg-ice" transition={{ type: 'spring', stiffness: 520, damping: 42 }} />}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {tab !== 'mine' && (
            <label className="pop-in flex h-[30px] w-[190px] items-center gap-2 rounded-ctl border border-line-2 px-2.5 text-mute transition-colors hover:border-line-3 focus-within:border-ice-line">
              <IconSearch size={13} />
              <span className="sr-only">Filtrer</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrer…" spellCheck={false} className="min-w-0 flex-1 bg-transparent text-[12px] text-text" />
            </label>
          )}
          <Menu<Sort>
            align="end"
            value={sort}
            onSelect={setSort}
            items={[
              { value: 'value', label: tab === 'mine' ? 'Valeur' : 'Capitalisation' },
              { value: 'change', label: 'Variation 24 h' },
              { value: 'name', label: 'Nom' },
            ]}
            trigger={
              <button type="button" className="press flex h-[30px] items-center gap-1.5 rounded-ctl border border-line-2 px-2.5 text-[12px] text-mute hover:border-line-3 hover:text-text">
                {sort === 'value' ? (tab === 'mine' ? 'Valeur' : 'Capitalisation') : sort === 'change' ? 'Variation' : 'Nom'} <IconChevronDown size={12} />
              </button>
            }
          />
        </div>
      </div>
      {tab === 'mine' ? <MineList sort={sort} /> : <MarketList sort={sort} query={query} favs={favs} toggle={toggle} onlyFavs={tab === 'favorites'} />}
    </section>
  );
}

function sortHoldings(rows: Holding[], sort: Sort): Holding[] {
  const r = [...rows];
  if (sort === 'name') r.sort((a, b) => a.asset.name.localeCompare(b.asset.name, 'fr'));
  if (sort === 'change') r.sort((a, b) => (b.change24h ?? -999) - (a.change24h ?? -999));
  return r;
}

function MineList({ sort }: { sort: Sort }) {
  const pf = usePortfolio();
  const torBlocked = useTorBlocked(Object.values(pf.chainErrors).join(' ') || undefined);
  const { network } = useApp();
  const downChains = Object.entries(pf.chainErrors)
    .filter(([, m]) => serverDown(m))
    .map(([k]) => findChain(network, k)?.label ?? k);
  const { settings, hideBalances, navigate, selectChainAccount } = useApp();
  const cur = settings.currency;
  // A chain with several vault accounts: one row per account (§2.9).
  const rows = sortHoldings(pf.accountHoldings, sort);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn(GRID, 'eyebrow h-8 shrink-0 px-5 whitespace-nowrap')}>
        <span>Actif</span>
        <span>Prix · 24 h</span>
        <span>7 jours</span>
        <span className="text-right">Solde</span>
        <span>Part</span>
      </div>
      <div key={pf.balancesLoaded ? 'rows' : 'skeleton'} className="stagger min-h-0 flex-1 overflow-y-auto scroll-thin">
        {!pf.balancesLoaded
          ? Array.from({ length: 4 }, (_, i) => (
              <div key={i} className={cn(GRID, 'h-[54px] border-t border-line/70 px-5')}>
                <span className="flex items-center gap-3">
                  <Skeleton className="size-[34px] rounded-full" />
                  <Skeleton className="h-3.5 w-24" />
                </span>
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="ml-auto h-3.5 w-20" />
                <Skeleton className="h-1 w-16" />
              </div>
            ))
          : rows.map((h, i) => (
              <button
                key={h.key}
                type="button"
                style={idx(i)}
                onClick={() => {
                  if (h.account) selectChainAccount(h.account.family, h.account.index);
                  navigate({ name: 'asset', id: h.asset.id });
                }}
                className={cn(GRID, 'group h-[54px] w-full border-t border-line/70 px-5 text-left transition-colors duration-150 hover:bg-raised/60')}>

                <span className="flex min-w-0 items-center gap-3">
                  <CoinIcon glyph={h.asset.glyph} color={h.asset.color} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[14px] font-medium">{h.asset.name}</span>
                    <span className="truncate text-[12px] text-mute">
                      {h.asset.symbol}
                      {h.asset.kind === 'erc20' ? ' · ERC-20' : h.asset.kind === 'spl' ? ' · SPL' : h.asset.kind === 'trc20' ? ' · TRC-20' : ''}
                      {h.account ? ` · ${h.account.name}` : ''}
                    </span>
                  </span>
                </span>
                <span className="flex flex-col">
                  <span className="text-[14px]">{h.price !== null ? fmtFiat(h.price, cur) : '—'}</span>
                  <span className={cn('text-[12px]', trendColor(h.change24h))}>{fmtPct(h.change24h)}</span>
                </span>
                {h.spark.length > 1 ? <Sparkline values={h.spark} color={trendHex(h.change7d)} /> : <span className="text-[12px] text-faint">—</span>}
                <span className="flex flex-col items-end">
                  <span className="text-[14px] font-medium">{hideBalances ? HIDDEN : h.value !== null ? fmtFiat(h.value, cur) : '—'}</span>
                  <span className="text-[12px] text-mute">{h.failed ? (torBlocked ? <span className="text-mute">en attente de Tor…</span> : serverMissing(pf.chainErrors[h.asset.chainKey]) ? <span className="text-warn">aucun serveur : à configurer</span> : serverDown(pf.chainErrors[h.asset.chainKey]) ? <span className="text-warn">ton serveur ne répond pas</span> : cbfPending(pf.chainErrors[h.asset.chainKey]) ? <span className="text-mute">synchronisation des filtres…</span> : <span className="text-warn">solde indisponible</span>) : hideBalances ? HIDDEN : fmtCrypto(h.amount, h.asset.decimals, h.asset.symbol)}</span>
                </span>
                <span className="flex items-center gap-2.5">
                  <span className="h-[3px] w-16 overflow-hidden rounded-full bg-control-2">
                    <motion.span className="block h-full rounded-full bg-text2" initial={{ width: 0 }} animate={{ width: `${Math.round(h.share * 100)}%` }} transition={{ duration: 0.5, delay: 0.1 + i * 0.03, ease: [0.22, 1, 0.36, 1] }} />
                  </span>
                  <span className="font-mono text-[11.5px] text-mute">{fmtNumber(h.share * 100, 0)}{' '}%</span>
                </span>
              </button>
            ))}
        {pf.balancesLoaded && WATCH_ONLY_CHAINS.map((w, i) => <WatchRow key={w.key} i={rows.length + i} coinId={w.coingeckoId} name={w.name} symbol={w.symbol} glyph={w.glyph} color={w.color} />)}
        {pf.balancesLoaded && pf.holdings.every((h) => h.amount === 0n) && (
          <EmptyState title="Ton coffre est vide pour l’instant" action={<button type="button" onClick={() => navigate({ name: 'receive' })} className="text-[13px] font-semibold text-ice hover:underline">Recevoir des fonds</button>}>
            Tes soldes apparaîtront ici dès la première réception.
          </EmptyState>
        )}
        {!torBlocked && downChains.length > 0 && <ServerDownLine className="px-5 py-3" what={downChains.join(', ')} />}
        {!torBlocked && Object.entries(pf.chainErrors).some(([k, m]) => k === 'dogecoin' && serverMissing(m)) && <ServerMissingLine className="px-5 py-3" coin="Dogecoin" />}
        {pf.marketError && <ErrorLine className="px-5 py-3" error={pf.marketError}>Prix indisponibles : {pf.marketError}</ErrorLine>}
      </div>
    </div>
  );
}

function WatchRow({ coinId, name, symbol, glyph, color, i }: { coinId: string; name: string; symbol: string; glyph: string; color: string; i: number }) {
  const pf = usePortfolio();
  const { settings, navigate } = useApp();
  const m = pf.marketById.get(coinId);
  const p = pf.price(coinId);
  return (
    <button type="button" style={idx(i)} onClick={() => navigate({ name: 'asset', id: `cg:${coinId}` })} className={cn(GRID, 'h-[54px] w-full border-t border-line/70 px-5 text-left transition-[background-color,filter] duration-150 [filter:saturate(.4)_brightness(.85)] hover:bg-raised/60 hover:[filter:none]')}>
      <span className="flex min-w-0 items-center gap-3">
        <CoinIcon glyph={glyph} color={color} fg="#C8CDD6" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[14px] font-medium">{name}</span>
          <span className="truncate text-[12px] text-mute">{symbol} · lecture seule</span>
        </span>
      </span>
      <span className="flex flex-col">
        <span className="text-[14px]">{p ? fmtFiat(p.price, settings.currency) : '—'}</span>
        <span className={cn('text-[12px]', trendColor(p?.change24h))}>{fmtPct(p?.change24h)}</span>
      </span>
      {m && m.sparkline7d.length > 1 ? <Sparkline values={m.sparkline7d} color={trendHex(m.change7d)} /> : <span />}
      <span className="flex flex-col items-end">
        <span className="text-[14px] font-medium">—</span>
        <span className="text-[12px] text-mute">Phase 4</span>
      </span>
      <span>
        <Badge tone="ice">Bientôt</Badge>
      </span>
    </button>
  );
}

function MarketList({ sort, query, favs, toggle, onlyFavs }: { sort: Sort; query: string; favs: string[]; toggle: (id: string) => void; onlyFavs: boolean }) {
  const pf = usePortfolio();
  const { settings, navigate } = useApp();
  const rows = useMemo(() => {
    let r: MarketCoin[] = pf.markets ?? [];
    if (onlyFavs) r = r.filter((c) => favs.includes(c.id));
    const q = query.trim().toLowerCase();
    if (q) r = r.filter((c) => c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q));
    r = [...r];
    if (sort === 'name') r.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    else if (sort === 'change') r.sort((a, b) => (b.change24h ?? -999) - (a.change24h ?? -999));
    else r.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
    return r;
  }, [pf.markets, onlyFavs, favs, query, sort]);
  const MG = 'grid grid-cols-[28px_minmax(0,1.6fr)_minmax(0,1fr)_104px_minmax(0,1fr)_36px] items-center gap-4';

  if (!pf.markets) {
    return pf.marketError ? (
      <ErrorLine className="px-5 py-6" onRetry={pf.refresh} error={pf.marketError}>
        Marché indisponible : {pf.marketError}
      </ErrorLine>
    ) : (
      <div className="flex flex-col gap-3 p-5">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn(MG, 'eyebrow h-8 shrink-0 px-5 whitespace-nowrap')}>
        <span>#</span>
        <span>Actif</span>
        <span>Prix · 24 h</span>
        <span>7 jours</span>
        <span className="text-right">Capitalisation</span>
        <span />
      </div>
      <div className="stagger min-h-0 flex-1 overflow-y-auto scroll-thin">
        {rows.length === 0 && (
          <EmptyState title={onlyFavs ? 'Aucun favori' : 'Aucun résultat'}>{onlyFavs ? 'Ajoute des actifs en favoris avec l’étoile, depuis l’onglet Marché.' : 'Essaie un autre nom ou symbole.'}</EmptyState>
        )}
        {rows.map((c, i) => {
          const fav = favs.includes(c.id);
          return (
            <div key={c.id} style={idx(i)} className={cn(MG, 'h-[50px] border-t border-line/70 px-5 transition-colors duration-150 hover:bg-raised/60')}>
              <span className="font-mono text-[11px] text-faint">{c.rank ?? '—'}</span>
              <button type="button" onClick={() => navigate({ name: 'asset', id: `cg:${c.id}` })} className="flex min-w-0 items-center gap-3 text-left">
                <CoinIcon glyph={c.symbol.slice(0, 1)} color="#22252B" fg="#C8CDD6" size={30} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[14px] font-medium">{c.name}</span>
                  <span className="text-[12px] text-mute">{c.symbol}</span>
                </span>
              </button>
              <span className="flex flex-col">
                <span className="text-[14px]">{fmtFiat(c.price, settings.currency)}</span>
                <span className={cn('text-[12px]', trendColor(c.change24h))}>{fmtPct(c.change24h)}</span>
              </span>
              {c.sparkline7d.length > 1 ? <Sparkline values={c.sparkline7d} color={trendHex(c.change7d)} /> : <span />}
              <span className="text-right text-[13px] text-text2">{c.marketCap !== null ? compactFiat(c.marketCap, settings.currency) : '—'}</span>
              <button type="button" aria-label={fav ? 'Retirer des favoris' : 'Ajouter aux favoris'} aria-pressed={fav} onClick={() => toggle(c.id)} className={cn('press flex size-8 items-center justify-center rounded-ctl', fav ? 'text-ice' : 'text-faint hover:text-text2')}>
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

export function compactFiat(v: number, cur: 'EUR' | 'USD'): string {
  const sym = cur === 'EUR' ? '€' : '$';
  if (v >= 1e12) return `${fmtNumber(v / 1e12, 2)} T${sym}`;
  if (v >= 1e9) return `${fmtNumber(v / 1e9, 1)} Md${sym}`;
  if (v >= 1e6) return `${fmtNumber(v / 1e6, 1)} M${sym}`;
  return fmtFiat(v, cur, { decimals: 0 });
}
