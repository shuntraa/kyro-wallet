// SPDX-License-Identifier: GPL-3.0-or-later
//
// Application state: vault lifecycle, settings, accounts/adapters, routing.
// No secret is ever stored here (passwords stay in the screen that asks for
// them; the recovery phrase lives only in the onboarding/reveal components).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ACCOUNT_CHAINS, call, EMPTY_SERVERS, isDemoMode, listenShell, toIpcError, type AccountChain, type Accounts, type ApiKeysUpdate, type AppConfig, type Network, type Settings, type VaultAccountLists, type VaultStatus, type WatchOnlyAccount } from '@kyro/shared';
import { createAdapters, hwToAccounts, type AdapterSet, type AnyAdapter, type WalletAccounts } from '@kyro/chains';
import { readJson, writeJson } from '../lib/storage';
import { accountAddress, defaultAccountName, familyAdapters } from '../lib/accounts';
import { CoinGeckoClient } from '@kyro/market';
import { createProviders, KYRO_SWAP_FEE, type SwapFeeConfig, type SwapProvider } from '@kyro/swap';

/** Demo mode only: obviously fake fee recipients so the swap screen has quotes (nothing is ever sent). */
const DEMO_SWAP_FEES: SwapFeeConfig = {
  ...KYRO_SWAP_FEE,
  recipients: { evm: '0x000000000000000000000000000000000000dEaD', solana: 'Vote111111111111111111111111111111111111111' },
  // Demo runs on devnet mints (USDC devnet) and also accepts wrapped SOL, so every demo pair quotes.
  solanaFeeMints: [...KYRO_SWAP_FEE.solanaFeeMints, '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 'So11111111111111111111111111111111111111112'],
};
import { torStore } from './tor';
import { settingsPayload } from '../lib/settingsPayload';
import { setLanguagePreference, setSystemLanguage, t } from '../i18n';

export type SettingsSection = 'security' | 'privacy' | 'accounts' | 'hardware' | 'networks' | 'display' | 'apikeys' | 'connections' | 'contacts';

export type Route =
  | { name: 'portfolio' }
  | { name: 'assets'; tab?: 'mine' | 'market' | 'favorites' }
  | { name: 'asset'; id: string }
  | { name: 'send'; assetId?: string; to?: string }
  | { name: 'receive'; family?: 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'tron' | 'xrp' | 'ada' | 'xlm' }
  | { name: 'swap'; sellAssetId?: string }
  | { name: 'history' }
  | { name: 'staking'; chain?: 'sol' | 'ada' | 'tron' }
  | { name: 'settings'; section?: SettingsSection; family?: AccountChain };

/**
 * One account of the active wallet on one chain family: a vault account of the user's list
 * (docs/IPC.md §2.9), or the hardware-wallet account. Public data only.
 */
export interface AccountSource {
  family: AccountChain;
  /** Vault account index (hardware wallet: its account number). */
  index: number;
  name: string;
  /** This account's adapters of the family (EVM: one per chain). */
  adapters: AnyAdapter[];
  /** Addresses of this account on the family (own addresses, poisoning check). */
  addresses: string[];
  /** Derivation path(s) of the account (vault; empty for a hardware wallet). */
  path: string;
}

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
  language: 'auto',
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
  /**
   * Accounts of the ACTIVE wallet: the vault, or a hardware-wallet account (only its chains).
   * Vault: per chain, the account selected with `selectChainAccount` (0 by default).
   */
  accounts: WalletAccounts | null;
  /** Adapters of `accounts` (vault: each family's adapter is its selected account's). */
  adapters: AdapterSet | null;
  /** Vault account lists per chain (§2.9); null while loading or without a vault. */
  vaultLists: VaultAccountLists | null;
  /** Re-reads the lists (after add / rename / remove); `select` activates an account. */
  refreshVaultAccounts: (select?: { family: AccountChain; index: number }) => Promise<void>;
  /** Selected vault account per chain (always 0 for a hardware-wallet account). */
  selectedAccounts: Record<AccountChain, number>;
  selectChainAccount: (family: AccountChain, index: number) => void;
  /** Every account of the active wallet, per family (portfolio, history, own addresses). */
  accountSources: AccountSource[];
  /** The vault has more than one account on `family` (show pickers and account names). */
  isMultiAccount: (family: AccountChain) => boolean;
  /** Name of the selected account of `family` (vault), or of the active wallet. */
  accountName: (family: AccountChain) => string;
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
  const [vaultLists, setVaultLists] = useState<VaultAccountLists | null>(null);
  /** accounts_get({ account }) of every listed index other than 0. */
  const [extraAccounts, setExtraAccounts] = useState<ReadonlyMap<number, Accounts>>(new Map());
  const [selection, setSelection] = useState<Partial<Record<AccountChain, number>>>({});
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
        ...(isDemoMode() ? { fees: DEMO_SWAP_FEES } : {}),
      }),
    [],
  );

  const toLocked = useCallback(() => {
    setVaultAccounts(null);
    setVaultLists(null);
    setExtraAccounts(new Map());
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
    setVaultLists(await call('vault_accounts_get').catch(() => null));
    setSelection(readJson<Partial<Record<AccountChain, number>>>(`accountSelection.${acc.network}`, {}));
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
        // Language first, so the first screen already speaks it (auto = Rust's system language).
        if (cfg.systemLanguage) setSystemLanguage(cfg.systemLanguage);
        setLanguagePreference(st.language);
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
      setLanguagePreference(saved.language);
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
  const serversKey = JSON.stringify(settings.servers);

  // ---- vault accounts (§2.9): public data of every listed account index ----
  const listedIndices = useMemo(() => {
    const set = new Set<number>([0]);
    if (vaultLists) for (const c of ACCOUNT_CHAINS) for (const e of vaultLists[c] ?? []) set.add(e.index);
    return [...set].sort((a, b) => a - b);
  }, [vaultLists]);
  useEffect(() => {
    if (!vaultAccounts) return;
    const missing = listedIndices.filter((i) => i !== 0 && !extraAccounts.has(i));
    if (missing.length === 0) return;
    let alive = true;
    void Promise.all(missing.map((i) => call('accounts_get', { account: i }).then((a) => [i, a] as const))).then(
      (got) => {
        if (!alive) return;
        setExtraAccounts((prev) => {
          const next = new Map(prev);
          for (const [i, a] of got) next.set(i, a);
          return next;
        });
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [vaultAccounts, listedIndices, extraAccounts]);
  /** Adapters per vault account index (signing commands carry the index). */
  const vaultSets = useMemo(() => {
    const out = new Map<number, { accounts: Accounts; adapters: AdapterSet }>();
    if (!vaultAccounts) return out;
    for (const i of listedIndices) {
      const acc = i === 0 ? vaultAccounts : extraAccounts.get(i);
      if (acc) out.set(i, { accounts: acc, adapters: createAdapters(acc, settingsRef.current.servers, undefined, undefined, i) });
    }
    return out;
  }, [vaultAccounts, extraAccounts, listedIndices, serversKey]);
  const selectedAccounts = useMemo(() => {
    const out = {} as Record<AccountChain, number>;
    for (const c of ACCOUNT_CHAINS) {
      const want = selection[c] ?? 0;
      const listed = vaultLists?.[c]?.some((e) => e.index === want) ?? want === 0;
      out[c] = !activeHw && listed && vaultSets.has(want) ? want : 0;
    }
    return out;
  }, [selection, vaultLists, vaultSets, activeHw]);

  const accounts = useMemo<WalletAccounts | null>(() => {
    if (activeHw) {
      try {
        return hwToAccounts(activeHw);
      } catch {
        return null;
      }
    }
    if (!vaultAccounts) return null;
    const of = (c: AccountChain) => vaultSets.get(selectedAccounts[c])?.accounts ?? vaultAccounts;
    return { network: vaultAccounts.network, btc: of('btc').btc, evm: of('evm').evm, sol: of('sol').sol, ltc: of('ltc').ltc, doge: of('doge').doge, tron: of('tron').tron, xrp: of('xrp').xrp, cardano: of('ada').cardano, stellar: of('xlm').stellar };
  }, [activeHw, vaultAccounts, vaultSets, selectedAccounts]);
  const hwAdapters = useMemo<AdapterSet | null>(
    () => (activeHw && accounts ? createAdapters(accounts, settingsRef.current.servers, undefined, { accountId: activeHw.id, device: activeHw.device }) : null),
    [accounts, serversKey, activeHw?.id],
  );
  const adapters = useMemo<AdapterSet | null>(() => {
    if (activeHw) return hwAdapters;
    const base = vaultSets.get(0)?.adapters;
    if (!base) return null;
    const of = (c: AccountChain) => vaultSets.get(selectedAccounts[c])?.adapters ?? base;
    const set: AdapterSet = { btc: of('btc').btc, evm: of('evm').evm, sol: of('sol').sol, ltc: of('ltc').ltc, doge: of('doge').doge, tron: of('tron').tron, xrp: of('xrp').xrp, cardano: of('ada').cardano, stellar: of('xlm').stellar, all: [], hw: null };
    set.all = ACCOUNT_CHAINS.flatMap((c) => familyAdapters(set, c));
    return set;
  }, [activeHw, hwAdapters, vaultSets, selectedAccounts]);

  const accountSources = useMemo<AccountSource[]>(() => {
    const addrs = (a: WalletAccounts | Accounts, c: AccountChain): string[] =>
      ({
        btc: [a.btc?.segwit.address, a.btc?.taproot.address],
        evm: [a.evm?.address],
        sol: [a.sol?.address],
        ltc: [a.ltc?.address],
        doge: [a.doge?.address],
        tron: [a.tron?.address],
        xrp: [a.xrp?.address],
        ada: [a.cardano?.address],
        xlm: [a.stellar?.address],
      })[c].filter((x): x is string => !!x);
    if (activeHw) {
      if (!hwAdapters || !accounts) return [];
      return ACCOUNT_CHAINS.map((c) => ({ family: c, index: activeHw.account, name: activeHw.label, adapters: familyAdapters(hwAdapters, c), addresses: addrs(accounts, c), path: '' })).filter((x) => x.adapters.length > 0);
    }
    const out: AccountSource[] = [];
    for (const c of ACCOUNT_CHAINS) {
      for (const e of vaultLists?.[c] ?? [{ index: 0, name: defaultAccountName(c, 0) }]) {
        const set = vaultSets.get(e.index);
        if (set) out.push({ family: c, index: e.index, name: e.name, adapters: familyAdapters(set.adapters, c), addresses: addrs(set.accounts, c), path: accountAddress(set.accounts, c).path });
      }
    }
    return out;
  }, [activeHw, hwAdapters, accounts, vaultLists, vaultSets]);

  const isMultiAccount = useCallback((c: AccountChain) => !activeHw && (vaultLists?.[c]?.length ?? 1) > 1, [activeHw, vaultLists]);
  const accountName = useCallback(
    (c: AccountChain) => (activeHw ? activeHw.label : (vaultLists?.[c]?.find((e) => e.index === selectedAccounts[c])?.name ?? t('settings.mainAccount'))),
    [activeHw, vaultLists, selectedAccounts],
  );
  const networkRef = useRef<Network | null>(null);
  networkRef.current = vaultAccounts?.network ?? null;
  const selectChainAccount = useCallback((c: AccountChain, index: number) => {
    setSelection((prev) => {
      const next = { ...prev, [c]: index };
      if (networkRef.current) writeJson(`accountSelection.${networkRef.current}`, next);
      return next;
    });
  }, []);
  const refreshVaultAccounts = useCallback(
    async (select?: { family: AccountChain; index: number }) => {
      const lists = await call('vault_accounts_get');
      // A just-created account: read its public addresses first, so the selection shows it at
      // once instead of falling back to account 0 until the background load ends.
      if (select && select.index !== 0) {
        const acc = await call('accounts_get', { account: select.index }).catch(() => null);
        if (acc) setExtraAccounts((prev) => (prev.has(select.index) ? prev : new Map(prev).set(select.index, acc)));
      }
      setVaultLists(lists);
      if (select) selectChainAccount(select.family, select.index);
    },
    [selectChainAccount],
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
    vaultLists,
    refreshVaultAccounts,
    selectedAccounts,
    selectChainAccount,
    accountSources,
    isMultiAccount,
    accountName,
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
