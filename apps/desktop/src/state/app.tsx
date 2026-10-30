// SPDX-License-Identifier: GPL-3.0-or-later
//
// Application state: vault lifecycle, settings, accounts/adapters, routing.
// No secret is ever stored here (passwords stay in the screen that asks for
// them; the recovery phrase lives only in the onboarding/reveal components).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { call, EMPTY_SERVERS, isDemoMode, listenShell, toIpcError, type Accounts, type AppConfig, type Network, type Settings, type VaultStatus } from '@kyro/shared';
import { createAdapters, type AdapterSet } from '@kyro/chains';
import { CoinGeckoClient } from '@kyro/market';
import { createProviders, type SwapProvider } from '@kyro/swap';
import { torStore } from './tor';

export type SettingsSection = 'security' | 'privacy' | 'hardware' | 'networks' | 'display' | 'apikeys' | 'connections' | 'contacts';

export type Route =
  | { name: 'portfolio' }
  | { name: 'assets'; tab?: 'mine' | 'market' | 'favorites' }
  | { name: 'asset'; id: string }
  | { name: 'send'; assetId?: string; to?: string }
  | { name: 'receive'; family?: 'btc' | 'evm' | 'sol' }
  | { name: 'swap'; sellAssetId?: string }
  | { name: 'history' }
  | { name: 'settings'; section?: SettingsSection };

export type Phase = 'boot' | 'welcome' | 'locked' | 'ready' | 'fatal';

const DEFAULT_SETTINGS: Settings = {
  currency: 'EUR',
  autoLockSecs: 900,
  hideBalancesOnStart: false,
  captureProtection: true,
  clipboardGuard: true,
  servers: EMPTY_SERVERS,
  apiKeys: {},
  tor: { enabled: true },
};

interface AppContextValue {
  phase: Phase;
  fatal: string | null;
  demo: boolean;
  network: Network;
  config: AppConfig | null;
  settings: Settings;
  saveSettings: (next: Settings) => Promise<void>;
  status: VaultStatus | null;
  refreshStatus: () => Promise<VaultStatus | null>;
  accounts: Accounts | null;
  adapters: AdapterSet | null;
  /** Called after create/import/unlock. */
  enterVault: () => Promise<void>;
  lock: () => Promise<void>;
  route: Route;
  navigate: (r: Route) => void;
  back: () => void;
  market: CoinGeckoClient;
  swapProviders: SwapProvider[];
  hideBalances: boolean;
  setHideBalances: (v: boolean) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('useApp hors AppProvider');
  return v;
}

/** Convenience: only valid inside the unlocked app. */
export function useVault(): AppContextValue & { accounts: Accounts; adapters: AdapterSet } {
  const v = useApp();
  if (!v.accounts || !v.adapters) throw new Error('Coffre verrouillé');
  return v as AppContextValue & { accounts: Accounts; adapters: AdapterSet };
}

const TOUCH_THROTTLE_MS = 15_000;

export function AppProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('boot');
  const [fatal, setFatal] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [adapters, setAdapters] = useState<AdapterSet | null>(null);
  const [history, setHistory] = useState<Route[]>([{ name: 'portfolio' }]);
  const [hideBalances, setHideBalances] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const configRef = useRef(config);
  configRef.current = config;

  const market = useMemo(() => new CoinGeckoClient(), []);
  const swapProviders = useMemo(
    () =>
      createProviders({
        hasZeroxKey: () => Boolean(configRef.current?.hasZeroxKey || settingsRef.current.apiKeys.zerox),
        hasOneinchKey: () => Boolean(configRef.current?.hasOneinchKey || settingsRef.current.apiKeys.oneinch),
      }),
    [],
  );

  const toLocked = useCallback(() => {
    setAccounts(null);
    setAdapters(null);
    setHistory([{ name: 'portfolio' }]);
    setPhase('locked');
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await call('vault_status');
      setStatus(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  const enterVault = useCallback(async () => {
    const s = await call('vault_status');
    setStatus(s);
    if (!s.exists) {
      setPhase('welcome');
      return;
    }
    if (!s.unlocked) {
      toLocked();
      return;
    }
    const acc = await call('accounts_get');
    setAccounts(acc);
    setAdapters(createAdapters(acc, settingsRef.current.servers));
    setHideBalances(settingsRef.current.hideBalancesOnStart);
    setHistory([{ name: 'portfolio' }]);
    setPhase('ready');
  }, [toLocked]);

  // Boot.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [cfg, st] = await Promise.all([call('config_get'), call('settings_get')]);
        if (!alive) return;
        setConfig(cfg);
        setSettings(st);
        settingsRef.current = st;
        torStore.setEnabled(st.tor.enabled);
        await enterVault();
      } catch (e) {
        if (!alive) return;
        setFatal(toIpcError(e).message);
        setPhase('fatal');
      }
    })();
    return () => {
      alive = false;
    };
  }, [enterVault]);

  // Shell event: auto-lock / sleep → unlock screen.
  useEffect(() => {
    let un: (() => void) | null = null;
    let cancelled = false;
    void listenShell('vault-locked', () => {
      toLocked();
      void refreshStatus();
    }).then((u) => {
      if (cancelled) u();
      else un = u;
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [toLocked, refreshStatus]);

  // Poll the vault status while unlocked (countdown + safety net if an event is missed).
  useEffect(() => {
    if (phase !== 'ready') return;
    const id = window.setInterval(async () => {
      const s = await refreshStatus();
      if (s && !s.unlocked) toLocked();
    }, 5000);
    return () => window.clearInterval(id);
  }, [phase, refreshStatus, toLocked]);

  // User activity → session_touch (throttled).
  useEffect(() => {
    if (phase !== 'ready') return;
    let last = 0;
    const touch = () => {
      const now = Date.now();
      if (now - last < TOUCH_THROTTLE_MS) return;
      last = now;
      void call('session_touch')
        .then(refreshStatus)
        .catch(() => undefined);
    };
    const evs: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'wheel'];
    evs.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, touch));
  }, [phase, refreshStatus]);

  const saveSettings = useCallback(
    async (next: Settings) => {
      const prev = settingsRef.current;
      const saved = await call('settings_set', { settings: next });
      setSettings(saved);
      settingsRef.current = saved;
      torStore.setEnabled(saved.tor.enabled);
      // New servers → new adapters (EVM / Solana URLs; Bitcoin: fresh scan cache on the new backend).
      if (JSON.stringify(saved.servers) !== JSON.stringify(prev.servers) && accounts) setAdapters(createAdapters(accounts, saved.servers));
      if (saved.apiKeys.coingecko !== prev.apiKeys.coingecko) market.clear();
      void refreshStatus();
    },
    [accounts, market, refreshStatus],
  );

  const lock = useCallback(async () => {
    try {
      await call('vault_lock');
    } finally {
      toLocked();
      void refreshStatus();
    }
  }, [toLocked, refreshStatus]);

  const navigate = useCallback((r: Route) => {
    setHistory((h) => {
      const top = h[h.length - 1];
      if (top && JSON.stringify(top) === JSON.stringify(r)) return h;
      // Rail destinations reset the stack; sub-screens push.
      const root = r.name === 'portfolio' || r.name === 'assets' || r.name === 'swap' || r.name === 'history' || r.name === 'settings';
      return root ? [r] : [...h, r].slice(-20);
    });
  }, []);
  const back = useCallback(() => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : [{ name: 'portfolio' }])), []);

  const value: AppContextValue = {
    phase,
    fatal,
    demo: isDemoMode(),
    network: config?.network ?? accounts?.network ?? 'testnet',
    config,
    settings,
    saveSettings,
    status,
    refreshStatus,
    accounts,
    adapters,
    enterVault,
    lock,
    route: history[history.length - 1] ?? { name: 'portfolio' },
    navigate,
    back,
    market,
    swapProviders,
    hideBalances,
    setHideBalances,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
