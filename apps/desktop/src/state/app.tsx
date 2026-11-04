// SPDX-License-Identifier: GPL-3.0-or-later
// Application state: vault lifecycle, settings, accounts/adapters, routing.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ACCOUNT_CHAINS, call, EMPTY_SERVERS, isDemoMode, listenShell, navigatorCurrency, toIpcError, type AccountChain, type Accounts, type ApiKeysUpdate, type AppConfig, type Network, type Settings, type VaultAccountLists, type VaultStatus, type WalletsInfo, type WatchAddress, type WatchOnlyAccount } from '@kyro/shared';
import { HIDDEN_FAMILIES, createAdapters, hwToAccounts, watchToAccounts, type AdapterSet, type AnyAdapter, type WalletAccounts } from '@kyro/chains';
import type { StakeChain } from '../lib/staking';
import { readJson, scoped, setWalletScope, writeJson } from '../lib/storage';
import { accountAddress, defaultAccountName, familyAdapters } from '../lib/accounts';
import { CoinGeckoClient } from '@kyro/market';
import { createProviders, KYRO_SWAP_FEE, type SwapFeeConfig, type SwapProvider } from '@kyro/swap';

const DEMO_SWAP_FEES: SwapFeeConfig = {
  ...KYRO_SWAP_FEE,
  recipients: { evm: '0x000000000000000000000000000000000000dEaD', solana: 'Vote111111111111111111111111111111111111111' },
  solanaFeeMints: [...KYRO_SWAP_FEE.solanaFeeMints, '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 'So11111111111111111111111111111111111111112'],
};
import { torStore } from './tor';
import { settingsPayload } from '../lib/settingsPayload';
import { setLanguagePreference, setSystemLanguage, t } from '../i18n';

/** Accounts without the chains hidden in this release (`HIDDEN_FAMILIES`). */
function visibleAccounts<T extends object>(acc: T): T {
  const out = { ...acc } as Record<string, unknown>;
  for (const f of HIDDEN_FAMILIES) delete out[f];
  return out as T;
}

export type SettingsSection = 'security' | 'privacy' | 'alerts' | 'accounts' | 'hardware' | 'networks' | 'display' | 'apikeys' | 'connections' | 'contacts';

export type Route =
  | { name: 'portfolio' }
  | { name: 'assets'; tab?: 'mine' | 'market' | 'favorites' }
  | { name: 'asset'; id: string }
  | { name: 'send'; assetId?: string; to?: string }
  | { name: 'receive'; family?: 'btc' | 'evm' | 'sol' | 'ltc' | 'doge' | 'bch' | 'dash' | 'zec' | 'tron' | 'xrp' | 'ada' | 'xlm' | 'near' | 'sui' | 'hbar' | 'kas' | 'dot' | 'algo' | 'xmr' | 'ton' | 'cosmos' | 'apt' }
  | { name: 'swap'; sellAssetId?: string }
  | { name: 'history' }
  | { name: 'staking'; chain?: StakeChain }
  | { name: 'settings'; section?: SettingsSection; family?: AccountChain };

/**
 * One account of the active wallet on one chain family: a vault account of the user's list
 * (docs/IPC.md §2.9), or the hardware-wallet account.
 */
export interface AccountSource {
  family: AccountChain;
  index: number;
  name: string;
  adapters: AnyAdapter[];
  /** Addresses of this account on the family (own addresses, poisoning check). */
  addresses: string[];
  path: string;
}

export type Phase = 'boot' | 'welcome' | 'locked' | 'ready' | 'fatal';

const DEFAULT_SETTINGS: Settings = {
  currency: navigatorCurrency(), // until Rust answers (it reads the OS locale, fiat.rs)
  autoLockSecs: 900,
  hideBalancesOnStart: false,
  captureProtection: true,
  clipboardGuard: true,
  servers: EMPTY_SERVERS,
  apiKeysSet: {},
  tor: { enabled: true },
  language: 'auto',
  autoUpdate: true,
  weeklyCount: true,
  closeToTray: false,
  lockOnHide: true,
  startMinimized: false,
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
  accounts: WalletAccounts | null;
  adapters: AdapterSet | null;
  vaultLists: VaultAccountLists | null;
  refreshVaultAccounts: (select?: { family: AccountChain; index: number }) => Promise<void>;
  selectedAccounts: Record<AccountChain, number>;
  selectChainAccount: (family: AccountChain, index: number) => void;
  accountSources: AccountSource[];
  isMultiAccount: (family: AccountChain) => boolean;
  accountName: (family: AccountChain) => string;
  /** Hardware-wallet accounts stored on this computer (public keys only). */
  hwAccounts: WatchOnlyAccount[];
  activeHw: WatchOnlyAccount | null;
  /** Public addresses and xpubs followed without a key. */
  watchAddresses: WatchAddress[];
  /** The active account when it is a watch address: nothing can be signed. */
  activeWatch: WatchAddress | null;
  refreshWatchAddresses: (select?: string) => Promise<void>;
  /** The wallets of this device: one recovery phrase and one password each. */
  wallets: WalletsInfo | null;
  /** Name of the wallet in use. */
  walletName: string;
  /** Name of wallet `id` (the default one when never renamed). */
  walletLabel: (id: string) => string;
  refreshWallets: () => Promise<void>;
  /** Ends the session and asks the password of `id`. */
  switchWallet: (id: string) => Promise<void>;
  /** Ends the session and opens the create or import flow for a new wallet. */
  addWallet: (name: string) => Promise<void>;
  cancelAddWallet: () => Promise<void>;
  activeAccountId: string;
  selectAccount: (id: string) => void;
  refreshHwAccounts: (select?: string) => Promise<void>;
  /** No vault on this computer: hardware-wallet-only user (no Kyro password, nothing to lock). */
  hwOnly: boolean;
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
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

/** Convenience: only valid inside the unlocked app. */
export function useVault(): AppContextValue & { accounts: WalletAccounts; adapters: AdapterSet } {
  const v = useApp();
  if (!v.accounts || !v.adapters) throw new Error('Vault locked');
  return v as AppContextValue & { accounts: WalletAccounts; adapters: AdapterSet };
}

const TOUCH_THROTTLE_MS = 15_000;

/** Local records of the first wallet keep their historical keys. */
const walletScopeOf = (s: VaultStatus | null): string => (s && s.walletId !== 'main' ? s.walletId : '');

export function AppProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('boot');
  const [fatal, setFatal] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [vaultAccounts, setVaultAccounts] = useState<Accounts | null>(null);
  const [vaultLists, setVaultLists] = useState<VaultAccountLists | null>(null);
  const [extraAccounts, setExtraAccounts] = useState<ReadonlyMap<number, Accounts>>(new Map());
  const [selection, setSelection] = useState<Partial<Record<AccountChain, number>>>({});
  const [hwAccounts, setHwAccounts] = useState<WatchOnlyAccount[]>([]);
  const [watchAddresses, setWatchAddresses] = useState<WatchAddress[]>([]);
  const [wallets, setWallets] = useState<WalletsInfo | null>(null);
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
    setSelection({});
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
    setWalletScope(walletScopeOf(s));
    setWallets(await call('wallets_get').catch(() => null));
    if (s.creating !== null) {
      setPhase('welcome');
      return;
    }
    const hw = await call('hw_accounts_get').catch(() => [] as WatchOnlyAccount[]);
    setHwAccounts(hw);
    const watched = await call('watch_addresses_get').catch(() => [] as WatchAddress[]);
    setWatchAddresses(watched);
    const known = (id: string) => hw.some((a) => a.id === id) || watched.some((w) => w.id === id);
    if (!s.exists) {
      // No vault, no password: hardware wallets confirm on the device, watch addresses sign nothing.
      if (hw.length === 0 && watched.length === 0) {
        setPhase('welcome');
        return;
      }
      setVaultAccounts(null);
      setActiveAccountId((prev) => (known(prev) ? prev : (hw[0]?.id ?? watched[0]?.id ?? 'vault')));
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
    setSelection(readJson<Partial<Record<AccountChain, number>>>(scoped(`accountSelection.${acc.network}`), {}));
    setActiveAccountId((prev) => (prev === 'vault' || known(prev) ? prev : 'vault'));
    setHideBalances(settingsRef.current.hideBalancesOnStart);
    setHistory([{ name: 'portfolio' }]);
    setPhase('ready');
  }, [toLocked]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [cfg, st] = await Promise.all([call('config_get'), call('settings_get')]);
        if (!alive) return;
        setConfig(cfg);
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

  useEffect(() => {
    if (phase !== 'ready') return;
    const id = window.setInterval(async () => {
      const s = await refreshStatus();
      if (s && s.exists && !s.unlocked) toLocked();
    }, 5000);
    return () => window.clearInterval(id);
  }, [phase, refreshStatus, toLocked]);

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
  const activeWatch = activeAccountId === 'vault' ? null : (watchAddresses.find((a) => a.id === activeAccountId) ?? null);
  const single = !!activeHw || !!activeWatch;
  setWalletScope(activeWatch ? activeWatch.id : walletScopeOf(status));
  const serversKey = JSON.stringify(settings.servers);

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
  const vaultSets = useMemo(() => {
    const out = new Map<number, { accounts: Accounts; adapters: AdapterSet }>();
    if (!vaultAccounts) return out;
    for (const i of listedIndices) {
      const acc = i === 0 ? vaultAccounts : extraAccounts.get(i);
      if (acc) out.set(i, { accounts: acc, adapters: createAdapters(visibleAccounts(acc), settingsRef.current.servers, undefined, undefined, i) });
    }
    return out;
  }, [vaultAccounts, extraAccounts, listedIndices, serversKey]);
  const selectedAccounts = useMemo(() => {
    const out = {} as Record<AccountChain, number>;
    for (const c of ACCOUNT_CHAINS) {
      const want = selection[c] ?? 0;
      const listed = vaultLists?.[c]?.some((e) => e.index === want) ?? want === 0;
      out[c] = !single && listed && vaultSets.has(want) ? want : 0;
    }
    return out;
  }, [selection, vaultLists, vaultSets, single]);

  const accounts = useMemo<WalletAccounts | null>(() => {
    if (activeHw) {
      try {
        return hwToAccounts(activeHw);
      } catch {
        return null;
      }
    }
    if (activeWatch) {
      try {
        return watchToAccounts(activeWatch, config?.network ?? 'testnet');
      } catch {
        return null;
      }
    }
    if (!vaultAccounts) return null;
    const of = (c: AccountChain) => vaultSets.get(selectedAccounts[c])?.accounts ?? vaultAccounts;
    return { network: vaultAccounts.network, btc: of('btc').btc, evm: of('evm').evm, sol: of('sol').sol, ltc: of('ltc').ltc, doge: of('doge').doge, bch: of('bch').bch, dash: of('dash').dash, zec: of('zec').zec, tron: of('tron').tron, xrp: of('xrp').xrp, cardano: of('ada').cardano, stellar: of('xlm').stellar, near: of('near').near, sui: of('sui').sui, hbar: of('hbar').hbar, ...(of('kas').kas ? { kas: of('kas').kas } : {}), polkadot: of('dot').polkadot, algo: of('algo').algo, xmr: of('xmr').xmr, ton: of('ton').ton, cosmos: of('cosmos').cosmos, aptos: of('apt').aptos };
  }, [activeHw, activeWatch, config?.network, vaultAccounts, vaultSets, selectedAccounts]);
  const hwAdapters = useMemo<AdapterSet | null>(
    () => (activeHw && accounts ? createAdapters(visibleAccounts(accounts), settingsRef.current.servers, undefined, { accountId: activeHw.id, device: activeHw.device }) : null),
    [accounts, serversKey, activeHw?.id],
  );
  const watchAdapters = useMemo<AdapterSet | null>(() => (activeWatch && accounts ? createAdapters(visibleAccounts(accounts), settingsRef.current.servers) : null), [accounts, serversKey, activeWatch?.id]);
  const adapters = useMemo<AdapterSet | null>(() => {
    if (activeHw) return hwAdapters;
    if (activeWatch) return watchAdapters;
    const base = vaultSets.get(0)?.adapters;
    if (!base) return null;
    const of = (c: AccountChain) => vaultSets.get(selectedAccounts[c])?.adapters ?? base;
    const set: AdapterSet = { btc: of('btc').btc, evm: of('evm').evm, sol: of('sol').sol, ltc: of('ltc').ltc, doge: of('doge').doge, bch: of('bch').bch, dash: of('dash').dash, tron: of('tron').tron, xrp: of('xrp').xrp, cardano: of('ada').cardano, stellar: of('xlm').stellar, near: of('near').near, sui: of('sui').sui, hbar: of('hbar').hbar, kaspa: of('kas').kaspa, polkadot: of('dot').polkadot, algo: of('algo').algo, xmr: of('xmr').xmr, ton: of('ton').ton, cosmos: of('cosmos').cosmos, aptos: of('apt').aptos, zec: of('zec').zec, all: [], hw: null, watch: false };
    set.all = ACCOUNT_CHAINS.flatMap((c) => familyAdapters(set, c));
    return set;
  }, [activeHw, hwAdapters, activeWatch, watchAdapters, vaultSets, selectedAccounts]);

  const accountSources = useMemo<AccountSource[]>(() => {
    const addrs = (a: WalletAccounts | Accounts, c: AccountChain): string[] =>
      ({
        btc: [a.btc?.segwit.address, a.btc?.taproot.address],
        evm: [a.evm?.address],
        sol: [a.sol?.address],
        ltc: [a.ltc?.address],
        doge: [a.doge?.address],
        bch: [a.bch?.address],
        dash: [a.dash?.address],
        tron: [a.tron?.address],
        xrp: [a.xrp?.address],
        ada: [a.cardano?.address],
        xlm: [a.stellar?.address],
        near: [a.near?.address],
        sui: [a.sui?.address],
        hbar: [a.hbar?.address],
        kas: [a.kas?.address],
        dot: [a.polkadot?.address],
        algo: [a.algo?.address],
        xmr: [a.xmr?.address],
        ton: [a.ton?.address],
        cosmos: [a.cosmos?.address],
        apt: [a.aptos?.address],
        zec: [a.zec?.address],
      })[c].filter((x): x is string => !!x);
    if (activeHw) {
      if (!hwAdapters || !accounts) return [];
      return ACCOUNT_CHAINS.map((c) => ({ family: c, index: activeHw.account, name: activeHw.label, adapters: familyAdapters(hwAdapters, c), addresses: addrs(accounts, c), path: '' })).filter((x) => x.adapters.length > 0);
    }
    if (activeWatch) {
      if (!watchAdapters || !accounts) return [];
      return ACCOUNT_CHAINS.map((c) => ({ family: c, index: 0, name: activeWatch.label, adapters: familyAdapters(watchAdapters, c), addresses: [...new Set(addrs(accounts, c))], path: '' })).filter((x) => x.adapters.length > 0);
    }
    const out: AccountSource[] = [];
    for (const c of ACCOUNT_CHAINS) {
      for (const e of vaultLists?.[c] ?? [{ index: 0, name: defaultAccountName(c, 0) }]) {
        const set = vaultSets.get(e.index);
        if (set) out.push({ family: c, index: e.index, name: e.name, adapters: familyAdapters(set.adapters, c), addresses: addrs(set.accounts, c), path: accountAddress(set.accounts, c).path });
      }
    }
    return out;
  }, [activeHw, hwAdapters, activeWatch, watchAdapters, accounts, vaultLists, vaultSets]);

  const isMultiAccount = useCallback((c: AccountChain) => !single && (vaultLists?.[c]?.length ?? 1) > 1, [single, vaultLists]);
  const accountName = useCallback(
    (c: AccountChain) => (activeHw ? activeHw.label : activeWatch ? activeWatch.label : (vaultLists?.[c]?.find((e) => e.index === selectedAccounts[c])?.name ?? t('settings.mainAccount'))),
    [activeHw, activeWatch, vaultLists, selectedAccounts],
  );
  const networkRef = useRef<Network | null>(null);
  networkRef.current = vaultAccounts?.network ?? null;
  const selectChainAccount = useCallback((c: AccountChain, index: number) => {
    setSelection((prev) => {
      const next = { ...prev, [c]: index };
      if (networkRef.current) writeJson(scoped(`accountSelection.${networkRef.current}`), next);
      return next;
    });
  }, []);
  const refreshVaultAccounts = useCallback(
    async (select?: { family: AccountChain; index: number }) => {
      const lists = await call('vault_accounts_get');
      // A just-created account: read its public addresses first, so the selection shows it at once
      // instead of falling back to account 0 until the background load ends.
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
  // Re-picking the active account (title-bar switcher) must not wipe the screen in use (e.g. «
  // Transaction diffusée »): only a real switch resets the stack.
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
      else setActiveAccountId((prev) => (prev === 'vault' || hw.some((a) => a.id === prev) || watchAddresses.some((w) => w.id === prev) ? prev : status?.exists ? 'vault' : (hw[0]?.id ?? watchAddresses[0]?.id ?? 'vault')));
      if (!status?.exists && hw.length === 0 && watchAddresses.length === 0) setPhase('welcome');
    },
    [status?.exists, watchAddresses],
  );

  const refreshWatchAddresses = useCallback(
    async (select?: string) => {
      const list = await call('watch_addresses_get');
      setWatchAddresses(list);
      if (select) setActiveAccountId(select);
      else setActiveAccountId((prev) => (prev === 'vault' || hwAccounts.some((a) => a.id === prev) || list.some((w) => w.id === prev) ? prev : status?.exists ? 'vault' : (hwAccounts[0]?.id ?? list[0]?.id ?? 'vault')));
      if (!status?.exists && hwAccounts.length === 0 && list.length === 0) setPhase('welcome');
    },
    [status?.exists, hwAccounts],
  );

  const walletLabel = useCallback((id: string) => wallets?.wallets.find((w) => w.id === id)?.name || t('settings.mainAccount'), [wallets]);
  const refreshWallets = useCallback(async () => setWallets(await call('wallets_get')), []);
  const switchWallet = useCallback(
    async (id: string) => {
      await call('wallet_switch', { id });
      setActiveAccountId('vault');
      toLocked();
      await enterVault();
    },
    [toLocked, enterVault],
  );
  const addWallet = useCallback(
    async (name: string) => {
      await call('wallet_new', { name });
      setActiveAccountId('vault');
      toLocked();
      await enterVault();
    },
    [toLocked, enterVault],
  );
  const cancelAddWallet = useCallback(async () => {
    await call('wallet_new_cancel');
    await enterVault();
  }, [enterVault]);

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
    watchAddresses,
    activeWatch,
    refreshWatchAddresses,
    wallets,
    walletName: walletLabel(wallets?.active ?? 'main'),
    walletLabel,
    refreshWallets,
    switchWallet,
    addWallet,
    cancelAddWallet,
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
