// SPDX-License-Identifier: GPL-3.0-or-later
import { lazy, Suspense, useCallback, useMemo } from 'react';
import { MotionConfig, motion } from 'motion/react';
import { WATCH_ONLY_CHAINS } from '@kyro/chains';
import { coinSearch } from './lib/coinSearch';
import { fmtNumber } from './lib/format';
import { AppProvider, useApp, type Route } from './state/app';
import { PortfolioProvider, usePortfolio } from './state/portfolio';
import { TitleBar, type SearchResult } from './shell/TitleBar';
import { NavRail } from './shell/NavRail';
import { StatusFrame } from './shell/StatusBar';
import { Welcome } from './screens/Welcome';
import { Unlock } from './screens/Unlock';
import { Portfolio } from './screens/Portfolio';
import { Assets } from './screens/Assets';
import { AssetDetail } from './screens/AssetDetail';
import { Send } from './screens/Send';
import { Receive } from './screens/Receive';
import { Swap } from './screens/Swap';
import { History } from './screens/History';
import { useHistoryWarmup } from './state/history';
import { SettingsScreen } from './screens/Settings';
import { KyroMark } from './components/kit';
import { Spinner } from './components/ui/primitives';
import { TorDialogs } from './components/Tor';
import { HwPromptLayer } from './components/hw';
import { UpdateNotice } from './components/UpdateNotice';
import { AccountSwitcher } from './components/AccountSwitcher';
import { screenEnter } from './components/motion';
import { t, useT } from './i18n';

const Staking = lazy(() => import('./screens/Staking').then((m) => ({ default: m.Staking })));
const Earn = lazy(() => import('./screens/Earn').then((m) => ({ default: m.Earn })));

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <AppProvider>
        <Root />
        {/* Tor failure / "continue without Tor" dialogs: reachable from every phase. */}
        <TorDialogs />
        {/* Trezor One blind PIN matrix, whatever screen started the device call. */}
        <HwPromptLayer />
        <UpdateNotice />
      </AppProvider>
    </MotionConfig>
  );
}

function Root() {
  const { phase, fatal } = useApp();
  const { t } = useT();
  if (phase === 'boot') {
    return (
      <Frame>
        <div className="flex flex-1 items-center justify-center gap-3 text-[13px] text-mute">
          <Spinner /> {t('shell.openingVault')}
        </div>
      </Frame>
    );
  }
  if (phase === 'fatal') {
    return (
      <Frame>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-10 text-center">
          <KyroMark size={48} />
          <h1 className="m-0 text-[24px] font-[560] tracking-[-0.03em]">{t('shell.startFailed')}</h1>
          <p className="m-0 max-w-[480px] text-[14px] text-mute">{fatal}</p>
        </div>
      </Frame>
    );
  }
  if (phase === 'welcome') return <Welcome />;
  if (phase === 'locked') return <Unlock />;
  return (
    <PortfolioProvider>
      <Unlocked />
    </PortfolioProvider>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-backdrop flex h-full flex-col text-text">
      <TitleBar bordered={false} />
      {children}
      <StatusFrame left={<span className="text-mute">Kyro Wallet</span>} />
    </div>
  );
}

function crumbsOf(r: Route, assetName: (id: string) => string): string[] {
  switch (r.name) {
    case 'portfolio':
      return [];
    case 'assets':
      return [t('shell.assets')];
    case 'asset':
      return [t('shell.assets'), assetName(r.id)];
    case 'send':
      return [t('common.send')];
    case 'receive':
      return [t('common.receive')];
    case 'swap':
      return ['Swap'];
    case 'history':
      return [t('common.history')];
    case 'staking':
      return r.chain ? [t('shell.earn'), { sol: 'Solana', ada: 'Cardano', tron: 'TRON', near: 'NEAR' }[r.chain]] : [t('shell.earn')];
    case 'settings':
      return [t('common.settings')];
  }
}

function Unlocked() {
  const { route, navigate, hideBalances } = useApp();
  const pf = usePortfolio();
  const { lang } = useT();
  useHistoryWarmup();

  const assetName = useCallback(
    (id: string) => {
      if (id.startsWith('cg:')) return pf.marketById.get(id.slice(3))?.name ?? id.slice(3);
      return pf.holdings.find((h) => h.asset.id === id)?.asset.name ?? id;
    },
    [pf.holdings, pf.marketById],
  );

  const search = useCallback(
    (q: string): SearchResult[] => {
      const s = q.toLowerCase();
      const out: SearchResult[] = [];
      for (const c of coinSearch(q, pf.holdings, pf.markets ?? [])) {
        out.push({
          id: c.id,
          label: c.name,
          hint: c.units !== null ? (hideBalances ? `••• ${c.symbol}` : `${fmtNumber(c.units, 6)} ${c.symbol}`) : t('shell.searchRank', { symbol: c.symbol, rank: c.rank ?? '—' }),
          icon: c.asset ?? { id: c.id, symbol: c.symbol },
          onSelect: () => navigate({ name: 'asset', id: c.id }),
        });
      }
      for (const w of WATCH_ONLY_CHAINS) {
        if (w.name.toLowerCase().includes(s) && !out.some((o) => o.id === `cg:${w.coingeckoId}`)) {
          out.push({ id: `cg:${w.coingeckoId}`, label: w.name, hint: t('shell.searchSoon'), onSelect: () => navigate({ name: 'asset', id: `cg:${w.coingeckoId}` }) });
        }
      }
      if (/^(0x[0-9a-fA-F]{40}|(bc|tb)1[0-9a-z]{20,}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(q)) {
        out.unshift({ id: `send:${q}`, label: t('shell.searchSendTo', { address: q.slice(0, 10) }), hint: t('shell.searchAddressHint'), onSelect: () => navigate({ name: 'send', to: q }) });
      }
      return out;
    },
    [pf.holdings, pf.markets, navigate, lang, hideBalances],
  );

  const screen = useMemo(() => {
    switch (route.name) {
      case 'portfolio':
        return <Portfolio />;
      case 'assets':
        return <Assets initialTab={route.tab ?? 'mine'} />;
      case 'asset':
        return <AssetDetail id={route.id} />;
      case 'send':
        return <Send {...(route.assetId ? { assetId: route.assetId } : {})} {...(route.to ? { to: route.to } : {})} />;
      case 'receive':
        return <Receive {...(route.family ? { family: route.family } : {})} />;
      case 'swap':
        return <Swap {...(route.sellAssetId ? { sellAssetId: route.sellAssetId } : {})} />;
      case 'history':
        return <History />;
      case 'staking':
        return (
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center gap-3 text-[13px] text-mute">
                <Spinner /> {t('common.loading')}
              </div>
            }
          >
            {route.chain ? <Staking chain={route.chain} /> : <Earn />}
          </Suspense>
        );
      case 'settings':
        return <SettingsScreen {...(route.section ? { section: route.section } : {})} {...(route.family ? { family: route.family } : {})} />;
    }
  }, [route, lang]);


  return (
    <div className="app-backdrop flex h-full flex-col text-text">
      <TitleBar crumbs={crumbsOf(route, assetName)} search={search} account={<AccountSwitcher />} />
      <div className="flex min-h-0 flex-1">
        <NavRail />
        {/*
         * Enter-only transition: the next screen mounts at once (an exit animation would block
         * navigation while the window is hidden and rAF is paused).
         */}
        <motion.main
          key={JSON.stringify(route)}
          {...screenEnter}
          className="flex min-w-0 flex-1 flex-col overflow-hidden"
        >
          {screen}
        </motion.main>
      </div>
    </div>
  );
}
