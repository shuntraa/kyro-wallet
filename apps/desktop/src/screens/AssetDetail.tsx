// SPDX-License-Identifier: GPL-3.0-or-later
import { useMemo, useState } from 'react';
import { assetsFor, evmChains, findAsset, findChain, WATCH_ONLY_CHAINS, type AssetDef } from '@kyro/chains';
import { useApp, useVault } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { PERIODS, useCoinChart, type Period } from '../state/charts';
import { useHistory } from '../state/history';
import { useOnTorReady } from '../state/tor';
import { cn } from '../lib/cn';
import { fmtAgo, fmtChartTime, fmtCrypto, fmtFiat, fmtNumber, fmtPct } from '../lib/format';
import { useAsync, useNow } from '../lib/useAsync';
import { CardanoTokensPanel } from '../components/Cardano';
import { AddressShort, BigFiat, CoinIcon, EmptyState, ErrorLine, HIDDEN, TrendPill } from '../components/kit';
import { SmoothChart } from '../components/charts';
import { HistoryRow } from '../components/HistoryRow';
import { useFavorites } from '../components/AssetLists';
import { AccountPicker } from '../components/AccountPicker';
import { Badge, Button, IconButton, Segmented, Skeleton } from '../components/ui/primitives';
import { IconBack, IconDown, IconStake, IconStar, IconSwap, IconUp } from '../components/icons';
import { idx } from '../components/motion';

export function AssetDetail({ id }: { id: string }) {
  const { back, settings, navigate, hideBalances, network, activeHw, isMultiAccount, selectedAccounts } = useApp();
  const { accounts, adapters } = useVault();
  const pf = usePortfolio();
  const { favs, toggle } = useFavorites();
  const [period, setPeriod] = useState<Period>('1J');
  const now = useNow(5000);
  const cur = settings.currency;

  const asset: AssetDef | undefined = id.startsWith('cg:') ? undefined : findAsset(network, id);
  const coinId = asset?.coingeckoId ?? id.replace(/^cg:/, '');
  const coin = pf.marketById.get(coinId);
  const watch = WATCH_ONLY_CHAINS.find((w) => w.coingeckoId === coinId);
  // A market coin we support natively → its native asset.
  const supported = asset ?? assetsFor(network).find((a) => a.coingeckoId === coinId && a.kind === 'native');
  // Several vault accounts on this chain (§2.9): the selected account's balance.
  const multi = !!supported && isMultiAccount(supported.family);
  const holding = supported ? (multi ? pf.accountHoldings.find((h) => h.asset.id === supported.id && h.account?.index === selectedAccounts[supported.family]) : pf.holdings.find((h) => h.asset.id === supported.id)) : undefined;
  const chart = useCoinChart(coinId, period);
  useOnTorReady(chart.reload);
  const month = useCoinChart(coinId, '1M');
  const history = useHistory();

  const name = supported?.name ?? coin?.name ?? watch?.name ?? coinId;
  const symbol = supported?.symbol ?? coin?.symbol ?? watch?.symbol ?? '';
  const color = supported?.color ?? watch?.color ?? '#22252B';
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

  // Same asset across EVM chains (same address).
  const perNetwork = useMemo(() => {
    if (!supported || supported.family !== 'evm') return [];
    return evmChains(network).map((c) => {
      const twin = assetsFor(network).find((a) => a.chainKey === c.key && a.coingeckoId === supported.coingeckoId);
      return { chain: c, asset: twin, amount: twin ? pf.balances.get(twin.id) ?? null : null };
    });
  }, [supported, network, pf.balances]);

  const activity = (history.data?.entries ?? []).filter((e) => supported && e.assetId === supported.id).slice(0, 6);
  const address = supported ? ({ btc: accounts.btc?.segwit.address, sol: accounts.sol?.address, evm: accounts.evm?.address, ltc: accounts.ltc?.address, doge: accounts.doge?.address, tron: accounts.tron?.address, xrp: accounts.xrp?.address, ada: accounts.cardano?.address, cosmos: accounts.cosmos?.address }[supported.family] ?? null) : null;
  const fav = favs.includes(coinId);
  const stakeChain = supported ? ({ sol: 'sol', ada: 'ada', tron: 'tron' } as const)[supported.family as 'sol' | 'ada' | 'tron'] : undefined;
  // Cardano: ADA tied to tokens and the native tokens themselves (not separate assets).
  const adaAccount = useAsync(supported?.family === 'ada' && adapters.cardano ? () => adapters.cardano!.account() : null, [supported?.id, adapters.cardano], { intervalMs: 30_000 });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-7 pt-6 pb-5">
      <header className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <IconButton label="Retour" onClick={back} className="size-9">
            <IconBack size={16} />
          </IconButton>
          <CoinIcon glyph={glyph} color={color} size={36} />
          <h1 className="screen-title truncate">{name}</h1>
          <span className="rounded-[4px] border border-line-3 px-1.5 py-0.5 font-mono text-[11px] font-medium text-text2">{symbol}</span>
          {coin?.rank && <span className="font-mono text-[11px] text-faint">Rang #{coin.rank}</span>}
          {supported && <AccountPicker family={supported.family} />}
          <button type="button" aria-label={fav ? 'Retirer des favoris' : 'Ajouter aux favoris'} aria-pressed={fav} onClick={() => toggle(coinId)} className={cn('press flex size-8 items-center justify-center rounded-ctl', fav ? 'text-ice' : 'text-faint hover:text-text2')}>
            <span key={String(fav)} className={fav ? 'pop-in inline-flex' : 'inline-flex'}>
              <IconStar size={18} filled={fav} />
            </span>
          </button>
        </div>
        {supported && !watch ? (
          <div className="flex gap-2">
            <Button variant="primary" size="lg" disabled={supported.readOnly} onClick={() => navigate({ name: 'send', assetId: supported.id })}>
              <IconUp size={16} /> Envoyer
            </Button>
            <Button size="lg" onClick={() => navigate({ name: 'receive', family: supported.family })}>
              <IconDown size={16} /> Recevoir
            </Button>
            <Button
              size="lg"
              disabled={supported.family !== 'evm' && supported.family !== 'sol'}
              title={supported.family !== 'evm' && supported.family !== 'sol' ? `Swap ${supported.name} : bientôt` : undefined}
              onClick={() => navigate({ name: 'swap', sellAssetId: supported.id })}
            >
              <IconSwap size={16} sw={2.2} /> Swap
            </Button>
            {/* Native staking: SOL, ADA, TRX only (none for BTC / LTC / DOGE / XRP, ETH out of scope). */}
            {supported.kind === 'native' && stakeChain && (
              <Button
                size="lg"
                disabled={!!activeHw}
                title={activeHw ? 'Staking indisponible sur un hardware wallet' : undefined}
                onClick={() => navigate({ name: 'staking', chain: stakeChain })}
              >
                <IconStake size={16} /> Staking
              </Button>
            )}
          </div>
        ) : (
          <Badge tone="ice" className="h-6 px-2">
            {watch ? 'Bientôt · lecture seule' : 'Non pris en charge'}
          </Badge>
        )}
      </header>

      <div className="flex min-h-0 flex-[1.15] gap-5">
        {/* Price + curve on the page itself, on a ruled baseline (no box). */}
        <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden border-b border-line">
          <div className="flex items-start justify-between pt-2">
            <div className="flex flex-col gap-2.5">
              <span className="eyebrow">
                Cours {symbol} / {cur}
              </span>
              <span className="figure text-[56px] leading-none tracking-[-0.045em]">{price ? <BigFiat value={price.price} currency={cur} tick className="fade-in inline-block" /> : <Skeleton className="h-12 w-56" />}</span>
              {changeAbs !== null && change !== null && (
                <span>
                  <TrendPill change={change}>
                    {fmtFiat(Math.abs(changeAbs), cur)} · {fmtPct(Math.abs(change), { sign: false })}
                  </TrendPill>
                </span>
              )}
            </div>
            <Segmented label="Période" value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p, label: p }))} />
          </div>
          <div className="mt-auto">
            {values.length > 1 ? (
              <SmoothChart
                key={period}
                values={values}
                height={250}
                defaultPoint="max"
                defaultLabel="PLUS HAUT"
                ariaLabel={`Cours de ${name}`}
                padTop={70}
                renderTooltip={(i) => ({ label: fmtChartTime(points[i]?.[0] ?? Date.now()), value: fmtFiat(values[i] ?? 0, cur) })}
              />
            ) : chart.error ? (
              <ErrorLine className="pb-8" onRetry={chart.reload} error={chart.error}>
                Graphique indisponible : {chart.error.message}
              </ErrorLine>
            ) : (
              <div className="pb-8">
                <Skeleton className="h-[180px] w-full" />
              </div>
            )}
          </div>
        </section>

        <aside className="rise flex w-[360px] shrink-0 flex-col gap-3 rounded-panel border border-line bg-card px-[22px] py-5">
          {supported && !watch ? (
            <>
              <span className="eyebrow">Ton solde</span>
              <span className="figure text-[34px] leading-none">{hideBalances ? HIDDEN : holding ? fmtCrypto(holding.amount, supported.decimals, supported.symbol) : '—'}</span>
              <span className="text-[14px] text-text2">
                {hideBalances ? HIDDEN : holding?.value !== null && holding?.value !== undefined ? `≈ ${fmtFiat(holding.value, cur)} · ${fmtNumber(holding.share * 100, 0)} % du portefeuille` : 'Prix indisponible'}
              </span>
              <div className="h-[3px] overflow-hidden rounded-full bg-control-2">
                <div className="h-full origin-left rounded-full bg-ice transition-[width] duration-500" style={{ width: `${Math.round((holding?.share ?? 0) * 100)}%` }} />
              </div>
              {perNetwork.length > 0 && (
                <div className="mt-2 flex flex-col">
                  <span className="eyebrow pb-2">Par réseau · même adresse</span>
                  {perNetwork.map(({ chain, asset: a, amount }) => (
                    <div key={chain.key} className="flex h-9 items-center justify-between border-t border-line text-[13px]">
                      <span className="flex items-center gap-2 text-text2">
                        <span className={cn('size-1.5 rounded-full', a && amount && amount > 0n ? 'bg-ice' : 'bg-faint')} />
                        {chain.name}
                      </span>
                      <span className={a && amount && amount > 0n ? 'font-medium' : 'text-mute'}>{!a ? 'non listé' : amount === null ? '—' : hideBalances ? HIDDEN : `${fmtCrypto(amount, a.decimals)}${chain.phase === 2 ? ' · phase 2' : ''}`}</span>
                    </div>
                  ))}
                  {network === 'testnet' && <span className="pt-2 text-[11px] text-faint">Arbitrum, Base, Optimism, Polygon, BNB et Avalanche : en mainnet.</span>}
                </div>
              )}
              {supported.family === 'ada' && <CardanoTokensPanel account={adaAccount.data} hidden={hideBalances} />}
              <div className="flex-1" />
              {/* Cardano: the tokens panel takes this room; « Recevoir » shows the same single address. */}
              {address && supported.family !== 'ada' && (
                <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
                  <AddressShort address={address} />
                  <Button size="sm" onClick={() => navigate({ name: 'receive', family: supported.family })}>
                    QR code
                  </Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState title={watch ? `${name} arrive en phase 4` : 'Actif non pris en charge'}>
              {watch ? 'Tu peux déjà suivre son cours. L’envoi et la réception seront ajoutés plus tard.' : 'Kyro affiche son cours, mais ne gère pas encore ce réseau.'}
            </EmptyState>
          )}
        </aside>
      </div>

      <div className="flex min-h-0 flex-1 gap-5">
        <section className="rise flex min-w-0 flex-1 flex-col overflow-hidden rounded-panel border border-line bg-card" style={idx(1)}>
          <div className="flex h-[50px] shrink-0 items-center justify-between border-b border-line px-5">
            <span className="text-[15px] font-medium tracking-[-0.01em]">Activité {symbol}</span>
            <button type="button" onClick={() => navigate({ name: 'history' })} className="text-[13px] font-medium text-ice hover:underline">
              Tout voir
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
            {history.loading && !history.data ? (
              <div className="flex flex-col gap-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
            ) : activity.length === 0 ? (
              <EmptyState title="Aucune activité">{supported ? 'Les transactions de cet actif apparaîtront ici.' : 'Aucun compte Kyro sur ce réseau.'}</EmptyState>
            ) : (
              <div className="stagger">{activity.map((e, i) => <HistoryRow key={e.id} i={i} e={e} compact price={price?.price ?? null} currency={cur} hidden={hideBalances} />)}</div>
            )}
          </div>
        </section>
        <section className="rise flex w-[360px] shrink-0 flex-col rounded-panel border border-line bg-card px-5 py-4" style={idx(2)}>
          <div className="flex items-baseline justify-between pb-3">
            <span className="text-[15px] font-medium tracking-[-0.01em]">Marché</span>
            <span className="font-mono text-[10.5px] text-faint">CoinGecko{pf.marketUpdatedAt ? ` · ${fmtAgo(pf.marketUpdatedAt, now)}` : ''}</span>
          </div>
          {[
            ['Plus haut 24 h', coin?.high24h !== null && coin?.high24h !== undefined ? fmtFiat(coin.high24h, cur) : '—', ''],
            ['Plus bas 24 h', coin?.low24h !== null && coin?.low24h !== undefined ? fmtFiat(coin.low24h, cur) : '—', ''],
            ['Variation 7 j', fmtPct(coin?.change7d), (coin?.change7d ?? 0) >= 0 ? 'text-up' : 'text-down'],
            ['Variation 30 j', fmtPct(change30), (change30 ?? 0) >= 0 ? 'text-up' : 'text-down'],
          ].map(([k, v, c]) => (
            <div key={k} className="flex h-9 items-center justify-between border-t border-line text-[13px]">
              <span className="text-mute">{k}</span>
              <span className={cn('font-medium', v === '—' ? 'text-mute' : c)}>{v}</span>
            </div>
          ))}
          {supported && findChain(network, supported.chainKey)?.network === 'testnet' && <p className="mt-auto pt-3 text-[11px] leading-[1.5] text-faint">Cours du mainnet : les jetons de test n’ont pas de valeur réelle.</p>}
        </section>
      </div>
    </div>
  );
}
