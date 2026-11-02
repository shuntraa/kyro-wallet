// SPDX-License-Identifier: GPL-3.0-or-later
import { lazy, Suspense, useCallback, useMemo } from 'react';
import { MotionConfig, motion } from 'motion/react';
import { matchesCoinQuery, WATCH_ONLY_CHAINS } from '@kyro/chains';
import { AppProvider, useApp, type Route } from './state/app';
import { PortfolioProvider, usePortfolio } from './state/portfolio';
import { TitleBar, type SearchResult } from './shell/TitleBar';
import { NavRail } from './shell/NavRail';
import { StatusBar, StatusFrame } from './shell/StatusBar';
import { Welcome } from './screens/Welcome';
import { Unlock } from './screens/Unlock';
import { Portfolio } from './screens/Portfolio';
import { Assets } from './screens/Assets';
import { AssetDetail } from './screens/AssetDetail';
import { Send } from './screens/Send';
import { Receive } from './screens/Receive';
import { Swap } from './screens/Swap';
import { History } from './screens/History';
import { SettingsScreen } from './screens/Settings';
import { KyroMark } from './components/kit';
import { Spinner } from './components/ui/primitives';
import { TorDialogs } from './components/Tor';
import { HwPromptLayer } from './components/hw';
import { UpdateNotice } from './components/UpdateNotice';
import { AccountSwitcher } from './components/AccountSwitcher';
import { networkDown, serverDown, serverMissing, useCustomServer } from './components/ServerDown';
import { screenEnter } from './components/motion';
import { t, useT } from './i18n';

const Staking = lazy(() => import('./screens/Staking').then((m) => ({ default: m.Staking })));

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
    <div className="flex h-full flex-col bg-bg text-text">
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
      return r.chain ? ['Staking', { sol: 'Solana', ada: 'Cardano', tron: 'TRON' }[r.chain]] : ['Staking'];
    case 'settings':
      return [t('common.settings')];
  }
}

function Unlocked() {
  const { route, navigate } = useApp();
  const pf = usePortfolio();
  const customServer = useCustomServer();
  const { lang } = useT();

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
      for (const h of pf.holdings) {
        if (matchesCoinQuery(s, h.asset)) {
          out.push({ id: h.asset.id, label: h.asset.name, hint: t('shell.searchMine', { symbol: h.asset.symbol }), onSelect: () => navigate({ name: 'asset', id: h.asset.id }) });
        }
      }
      for (const c of pf.markets ?? []) {
        if (out.length >= 8) break;
        if (matchesCoinQuery(s, { name: c.name, symbol: c.symbol, coingeckoId: c.id })) {
          out.push({ id: `cg:${c.id}`, label: c.name, hint: t('shell.searchRank', { symbol: c.symbol, rank: c.rank ?? '—' }), onSelect: () => navigate({ name: 'asset', id: `cg:${c.id}` }) });
        }
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
    [pf.holdings, pf.markets, navigate, lang],
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
            <Staking {...(route.chain ? { chain: route.chain } : {})} />
          </Suspense>
        );
      case 'settings':
        return <SettingsScreen {...(route.section ? { section: route.section } : {})} {...(route.family ? { family: route.family } : {})} />;
    }
  }, [route, lang]);

  const failed = Object.entries(pf.chainErrors).filter(([, m]) => !serverMissing(m)).map(([k]) => k);

  return (
    <div className="flex h-full flex-col bg-bg text-text">
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
      <StatusBar syncing={pf.balancesLoading && !pf.balancesLoaded} failedChains={failed} serverDownChains={Object.entries(pf.chainErrors).filter(([k, m]) => serverDown(m, customServer(k))).map(([k]) => k)} networkDownChains={Object.entries(pf.chainErrors).filter(([k, m]) => networkDown(m, customServer(k))).map(([k]) => k)} />
    </div>
  );
}
