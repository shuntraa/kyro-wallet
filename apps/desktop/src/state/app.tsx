// SPDX-License-Identifier: GPL-3.0-or-later
//
// Application state: vault lifecycle, settings, accounts/adapters, routing.
// No secret is ever stored here (passwords stay in the screen that asks for
// them; the recovery phrase lives only in the onboarding/reveal components).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { call, EMPTY_SERVERS, isDemoMode, listenShell, toIpcError, type Accounts, type ApiKeysUpdate, type AppConfig, type Network, type Settings, type VaultStatus, type WatchOnlyAccount } from '@kyro/shared';
import { createAdapters, hwToAccounts, type AdapterSet, type WalletAccounts } from '@kyro/chains';
import { CoinGeckoClient } from '@kyro/market';
import { createProviders, type SwapProvider } from '@kyro/swap';
import { torStore } from './tor';
import { settingsPayload } from '../lib/settingsPayload';

export type SettingsSection = 'security' | 'privacy' | 'hardware' | 'networks' | 'display' | 'apikeys' | 'connections' | 'contacts';

export type Route =
  | { name: 'portfolio' }
  | { name: 'assets'; tab?: 'mine' | 'market' | 'favorites' }
  | { name: 'asset'; id: string }
  | { name: 'send'; assetId?: string; to?: string }
  | { name: 'receive'; family?: 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'tron' | 'xrp' | 'ada' }
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
  apiKeysSet: {},
  tor: { enabled: true },
};

interface AppContextValue {
  phase: Phase;
  fatal: string | null;
  demo: boolean;
  network: Network;
  config: AppConfig | null;
  settings: Settings;
  /** `apiKeys`: key changes the user just typed (absent = unchanged, "" = remove). Never a stored key. */
  saveSettings: (next: Settings, apiKeys?: ApiKeysUpdate) => Promise<void>;
  status: VaultStatus | null;
  refreshStatus: () => Promise<VaultStatus | null>;
  /** Accounts of the ACTIVE wallet: the vault, or a hardware-wallet account (only its chains). */
  accounts: WalletAccounts | null;
  adapters: AdapterSet | null;
  /** Hardware-wallet accounts stored on this computer (public keys only). */
  hwAccounts: WatchOnlyAccount[];
  /** The active hardware-wallet account, or null when the vault is active. */
  activeHw: WatchOnlyAccount | null;
  /** `'vault'` or a hardware-wallet account id. */
  activeAccountId: string;
  selectAccount: (id: string) => void;
  /** Re-reads `hw_accounts_get` (after add / remove). Activates `select` when given. */
  refreshHwAccounts: (select?: string) => Promise<void>;
  /** No vault on this computer: hardware-wallet-only user (no Kyro password, nothing to lock). */
  hwOnly: boolean;
  /** Called after create/import/unlock, or after adding the first hardware wallet. */
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
export function useVault(): AppContextValue & { accounts: WalletAccounts; adapters: AdapterSet } {
  const v = useApp();
  if (!v.accounts || !v.adapters) throw new Error('Coffre verrouillé');
  return v as AppContextValue & { accounts: WalletAccounts; adapters: AdapterSet };
}

const TOUCH_THROTTLE_MS = 15_000;

export function AppProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('boot');
  const [fatal, setFatal] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [vaultAccounts, setVaultAccounts] = useState<Accounts | null>(null);
  const [hwAccounts, setHwAccounts] = useState<WatchOnlyAccount[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string>('vault');
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
        hasZeroxKey: () => Boolean(configRef.current?.hasZeroxKey || settingsRef.current.apiKeysSet.zerox),
        hasOneinchKey: () => Boolean(configRef.current?.hasOneinchKey || settingsRef.current.apiKeysSet.oneinch),
      }),
    [],
  );

  const toLocked = useCallback(() => {
    setVaultAccounts(null);
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
    const hw = await call('hw_accounts_get').catch(() => [] as WatchOnlyAccount[]);
    setHwAccounts(hw);
    if (!s.exists) {
      // Hardware-wallet-only user: no vault, no password; the device confirms everything.
      if (hw.length === 0) {
        setPhase('welcome');
        return;
      }
      setVaultAccounts(null);
      setActiveAccountId((prev) => (hw.some((a) => a.id === prev) ? prev : (hw[0]?.id ?? 'vault')));
      setHideBalances(settingsRef.current.hideBalancesOnStart);
      setHistory([{ name: 'portfolio' }]);
      setPhase('ready');
      return;
    }
    if (!s.unlocked) {
      toLocked();
      return;
    }
    const acc = await call('accounts_get');
    setVaultAccounts(acc);
    setActiveAccountId((prev) => (prev === 'vault' || hw.some((a) => a.id === prev) ? prev : 'vault'));
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
      // Hardware-wallet-only user: no vault, nothing to lock.
      if (s && s.exists && !s.unlocked) toLocked();
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
    async (next: Settings, apiKeys?: ApiKeysUpdate) => {
      const saved = await call('settings_set', { settings: settingsPayload(next, apiKeys) });
      setSettings(saved);
      settingsRef.current = saved;
      torStore.setEnabled(saved.tor.enabled);
      // New servers → new adapters (memo below, keyed on the servers).
      if (apiKeys?.coingecko !== undefined) market.clear();
      // The shell's view of the keys (hasTrongridKey…) changes with them.
      if (apiKeys && Object.keys(apiKeys).length > 0) void call('config_get').then(setConfig).catch(() => undefined);
      void refreshStatus();
    },
    [market, refreshStatus],
  );

  const activeHw = activeAccountId === 'vault' ? null : (hwAccounts.find((a) => a.id === activeAccountId) ?? null);
  const accounts = useMemo<WalletAccounts | null>(() => {
    if (activeHw) {
      try {
        return hwToAccounts(activeHw);
      } catch {
        return null;
      }
    }
    return vaultAccounts;
  }, [activeHw, vaultAccounts]);
  const serversKey = JSON.stringify(settings.servers);
  const adapters = useMemo<AdapterSet | null>(
    () => (accounts ? createAdapters(accounts, settingsRef.current.servers, undefined, activeHw ? { accountId: activeHw.id, device: activeHw.device } : undefined) : null),
    [accounts, serversKey, activeHw?.id],
  );

  const activeAccountRef = useRef(activeAccountId);
  activeAccountRef.current = activeAccountId;
  // Re-picking the active account (title-bar switcher) must not wipe the screen in use
  // (e.g. « Transaction diffusée »): only a real switch resets the stack.
  const selectAccount = useCallback((id: string) => {
    if (id === activeAccountRef.current) return;
    setActiveAccountId(id);
    setHistory([{ name: 'portfolio' }]);
  }, []);

  const refreshHwAccounts = useCallback(
    async (select?: string) => {
      const hw = await call('hw_accounts_get');
      setHwAccounts(hw);
      if (select) setActiveAccountId(select);
      else setActiveAccountId((prev) => (prev === 'vault' || hw.some((a) => a.id === prev) ? prev : status?.exists ? 'vault' : (hw[0]?.id ?? 'vault')));
      if (!status?.exists && hw.length === 0) setPhase('welcome');
    },
    [status?.exists],
  );

  const lock = useCallback(async () => {
    if (status && !status.exists) return; // hardware-wallet-only: no vault to lock
    try {
      await call('vault_lock');
    } finally {
      toLocked();
      void refreshStatus();
    }
  }, [toLocked, refreshStatus, status]);

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
    hwAccounts,
    activeHw,
    activeAccountId,
    selectAccount,
    refreshHwAccounts,
    hwOnly: status !== null && !status.exists,
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
