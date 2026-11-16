// SPDX-License-Identifier: GPL-3.0-or-later
// Settings: the wallet in its ice ring, then groups of rows on glass (two columns). Each longer
// setting opens a sub-page in the same language.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { call, FIAT_CURRENCIES, isDemoMode, intlLocale, toIpcError, type AccountChain, type ApiKeyName, type Currency, type Settings } from '@kyro/shared';
import { findLookalike, outgoingHosts, type KnownAddress } from '@kyro/chains';
import { useApp, useVault, type SettingsSection } from '../state/app';
import { cn } from '../lib/cn';
import { fiatSymbol, fmtFiat, shortAddress } from '../lib/format';
import { getBackupState, getContacts, saveContacts, type Contact, type ContactFamily } from '../lib/storage';
import { PasswordField } from '../components/kit';
import { CoinIcon } from '../components/coins/CoinIcon';
import { adapterValidator, CONTACT_FAMILY_META, detectFamilies } from '../lib/contactDetect';
import { familyAdapters } from '../lib/accounts';
import { PoisoningWarning } from '../components/Poisoning';
import { ServersSection } from './settings/Servers';
import { NetDiagnostics } from './settings/Diagnostics';
import { Devices } from './settings/Devices';
import { AccountsSection } from './settings/Accounts';
import { ChangePassword } from './settings/ChangePassword';
import { SecondPassword } from './settings/SecondPassword';
import { Dialog } from '../components/ui/dialog';
import { Badge, Button, Input, Notice, Spinner } from '../components/ui/primitives';
import { Menu } from '../components/ui/menu';
import { IconCheck, IconChevronRight, IconTor, IconTrash, IconWarn, IconX } from '../components/icons';
import { DISPLAY, Frost, GlassButton, IceDot, IceSquare, Switch, VaultRing } from '../components/kyro';
import { torIndicator, torStore, useTor } from '../state/tor';
import { useT, type Key } from '../i18n';
import { XmrWalletSection } from '../components/Monero';
import { AlertsSection } from './settings/Alerts';
import { BackupSection } from './settings/Backup';
import { TorBridges } from './settings/TorBridges';
import { SpendLimitSection } from './settings/SpendLimit';
import { Group, Pick, Row, RowAction, SubPage } from './settings/parts';
import { PasswordGate, useContactGuard } from '../components/ContactsOnly';

export const SETTINGS_SECTIONS: Array<{ key: SettingsSection; label: Key }> = [
  { key: 'security', label: 'settings.sectionSecurity' },
  { key: 'privacy', label: 'settings.sectionPrivacy' },
  { key: 'alerts', label: 'settings.sectionAlerts' },
  { key: 'accounts', label: 'settings.sectionAccounts' },
  { key: 'hardware', label: 'settings.sectionHardware' },
  { key: 'networks', label: 'settings.sectionNetworks' },
  { key: 'display', label: 'settings.sectionDisplay' },
  { key: 'apikeys', label: 'settings.sectionApiKeys' },
  { key: 'connections', label: 'settings.sectionConnections' },
  { key: 'contacts', label: 'settings.sectionContacts' },
  { key: 'backup', label: 'settings.sectionBackup' },
];

/** Sub-pages. `security` and `display` live on the main page itself. */
type Page = Exclude<SettingsSection, 'security' | 'display'> | 'protection' | 'monero';

const PAGE_TITLE: Record<Page, Key> = {
  privacy: 'settings.sectionPrivacy',
  alerts: 'settings.sectionAlerts',
  accounts: 'settings.sectionAccounts',
  hardware: 'settings.sectionHardware',
  networks: 'settings.sectionNetworks',
  apikeys: 'settings.sectionApiKeys',
  connections: 'settings.sectionConnections',
  contacts: 'settings.sectionContacts',
  backup: 'settings.sectionBackup',
  protection: 'settings.groupProtection',
  monero: 'settings.moneroWallet',
};

function pageOf(section: SettingsSection | undefined): Page | null {
  return !section || section === 'security' || section === 'display' ? null : section;
}

/** Demo only (browser review, never the desktop app): `?settings=networks` opens that sub-page. */
function demoPage(): Page | null {
  if (!isDemoMode() || typeof window === 'undefined') return null;
  const p = new URLSearchParams(window.location.search).get('settings');
  return (Object.keys(PAGE_TITLE) as Page[]).find((x) => x === p) ?? null;
}

/** Same networks count as the welcome screen. */
const NETWORKS = 36;

export function SettingsScreen({ section, family }: { section?: SettingsSection; family?: AccountChain }) {
  const { settings, saveSettings, route } = useApp();
  const [page, setPage] = useState<Page | null>(() => pageOf(section) ?? demoPage());
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { t } = useT();
  // A new route (Settings icon, a « Réglages › Réseaux » link) opens the page it names.
  const shown = useRef(route);
  useEffect(() => {
    if (shown.current === route) return;
    shown.current = route;
    setPage(pageOf(section));
  }, [route]);

  const save = async (patch: Partial<Settings>) => {
    setError(null);
    try {
      await saveSettings({ ...settings, ...patch });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(toIpcError(e).message);
    }
  };

  const status = (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      {saved && (
        <span role="status" className="fade-in flex items-center gap-2 text-[12px] text-mute">
          <IceDot /> {t('settings.saved')}
        </span>
      )}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
      <div className="mx-auto mt-8 flex w-[min(1000px,calc(100%-48px))] flex-col pb-12">
        {page ? (
          <SubPage key={page} title={(t as (k: Key) => string)(PAGE_TITLE[page])} onBack={() => setPage(null)} aside={page === 'networks' || page === 'privacy' ? <Connections compact /> : undefined}>
            {page === 'privacy' && <Privacy />}
            {page === 'alerts' && <AlertsSection />}
            {page === 'accounts' && <AccountsSection {...(family ? { family } : {})} />}
            {page === 'hardware' && <Devices />}
            {page === 'networks' && (
              <>
                <NetDiagnostics />
                <ServersSection />
              </>
            )}
            {page === 'apikeys' && <ApiKeys />}
            {page === 'connections' && <Connections />}
            {page === 'contacts' && <Contacts />}
            {page === 'backup' && <BackupSection />}
            {page === 'protection' && (
              <>
                <SpendLimitSection />
                <SecondPassword />
              </>
            )}
            {page === 'monero' && <MoneroWallet />}
            {status}
          </SubPage>
        ) : (
          <Overview save={save} open={setPage} status={status} />
        )}
      </div>
    </div>
  );
}

type Save = (patch: Partial<Settings>) => Promise<void>;

function currencyLabel(c: Currency): string {
  const sym = fiatSymbol(c);
  let name: string = c;
  try {
    const n = new Intl.DisplayNames([intlLocale()], { type: 'currency' }).of(c);
    if (n) name = n.charAt(0).toUpperCase() + n.slice(1);
  } catch {
    /* name stays the code */
  }
  return sym && sym !== c ? `${name} (${sym})` : name;
}

function useUpdateStore(): boolean {
  // Microsoft Store (MSIX) install: the Store updates Kyro, its own updater is off.
  const [store, setStore] = useState(false);
  useEffect(() => {
    let alive = true;
    call('update_status')
      .then((s) => alive && setStore(s.store))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return store;
}

function Overview({ save, open, status }: { save: Save; open: (p: Page) => void; status: ReactNode }) {
  const { settings, config, network, walletName, wallets, walletLabel, switchWallet, lock, hwOnly, adapters, saveSettings } = useApp();
  const [contactsOff, setContactsOff] = useState(false);
  const tor = useTor();
  const { t, tp } = useT();
  const store = useUpdateStore();
  const [reveal, setReveal] = useState(false);
  const backup = getBackupState();
  const several = (wallets?.wallets.length ?? 1) > 1;
  const hosts = outgoingHosts(network, settings.servers).length;

  const facts = [
    hwOnly ? t('settings.factHwOnly') : t('settings.factNetworks', { n: NETWORKS }),
    several ? tp('settings.factWallets', wallets?.wallets.length ?? 1) : null,
    hwOnly ? null : backup === 'confirmed' ? t('settings.factBackupOk') : backup === 'imported' ? t('settings.factImported') : t('settings.factBackupUnverified'),
  ].filter(Boolean);

  const kind = torIndicator(tor);
  const torValue =
    kind === 'ready' ? (
      <>
        <IceDot /> {t('settings.torConnected')}
      </>
    ) : kind === 'bootstrapping' ? (
      <span className="tabular-nums">{t('settings.torConnecting', { p: Math.max(0, Math.min(99, Math.round(tor.status?.progress ?? 0))) })}</span>
    ) : kind === 'failed' ? (
      <span className="text-warn">{t('settings.torFailed')}</span>
    ) : kind === 'direct' ? (
      <span className="text-warn">{t('settings.torOff')}</span>
    ) : (
      <span className="text-faint">…</span>
    );

  const changeWallet = several ? (
    <Menu
      align="end"
      onSelect={(v: string) => (v === '__manage' ? open('accounts') : void switchWallet(v))}
      items={[
        ...(wallets?.wallets ?? []).filter((w) => w.id !== wallets?.active).map((w) => ({ value: w.id, label: walletLabel(w.id), hint: t('wallets.switchHint') })),
        { value: '__manage', label: t('settings.manageWallets') },
      ]}
      trigger={<GlassButton className="w-[200px]">{t('settings.changeWallet')}</GlassButton>}
    />
  ) : (
    <GlassButton className="w-[200px]" onClick={() => open('accounts')}>
      {t('settings.changeWallet')}
    </GlassButton>
  );

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-6">
        <VaultRing size={86} segs={[{ color: '#ffffff', part: 1, ice: true }]}>
          <IceSquare size={20} />
        </VaultRing>
        <span className="flex min-w-0 flex-col">
          <h1 className="m-0 truncate text-[22px] leading-none font-normal" style={{ ...DISPLAY, fontWeight: 400, letterSpacing: '-0.03em' }}>
            {walletName}
          </h1>
          <span className="mt-2.5 text-[12.5px] text-faint">{facts.join(' · ')}</span>
        </span>
        <span className="ml-auto flex shrink-0 gap-2.5">
          {changeWallet}
          {!hwOnly && (
            <Frost className="h-11 w-[150px] rounded-[14px] text-[13.5px]" onClick={() => void lock()}>
              {t('settings.lockNow')}
            </Frost>
          )}
        </span>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-6">
        <Group title={t('settings.sectionSecurity')}>
          <Row label={t('settings.autoLock')}>
            <Pick
              label={t('settings.autoLockDelay')}
              value={String(settings.autoLockSecs)}
              onSelect={(v) => void save({ autoLockSecs: Number(v) })}
              items={[300, 900, 1800, 3600].map((s) => ({ value: String(s), label: s === 3600 ? t('settings.afterHour') : t('settings.afterMin', { n: s / 60 }) }))}
            />
          </Row>
          {!hwOnly && (
            <Row label={t('common.password')}>
              <ChangePassword trigger={(go) => <RowAction onClick={go}>{t('settings.change')}</RowAction>} />
            </Row>
          )}
          {!hwOnly && (
            <Row label={t('settings.recoveryPhrase')} sub={backup === 'unknown' ? <span className="text-warn">{t('settings.backupUnverified')}</span> : undefined}>
              <RowAction onClick={() => setReveal(true)}>{t('common.show')}</RowAction>
            </Row>
          )}
        </Group>

        <Group title={t('settings.sectionPrivacy')}>
          <Row label="Tor" onClick={() => open('privacy')} chevron>
            {torValue}
          </Row>
          <Row label={t('settings.hideBalances')}>
            <Switch label={t('settings.hideBalances')} on={settings.hideBalancesOnStart} onChange={(v) => void save({ hideBalancesOnStart: v })} />
          </Row>
          <Row label={t('settings.cryptoPrices')} onClick={() => open('apikeys')} chevron>
            CoinGecko
          </Row>
        </Group>

        <Group title={t('settings.groupDisplay')}>
          <Row label={t('settings.language')}>
            <Pick
              label={t('settings.language')}
              value={settings.language}
              onSelect={(v) => void save({ language: v })}
              items={[
                { value: 'auto', label: t('settings.languageAuto'), short: t('settings.languageAutoShort') },
                { value: 'fr', label: t('settings.languageFr') },
                { value: 'en', label: t('settings.languageEn') },
              ]}
            />
          </Row>
          <Row label={t('settings.currency')}>
            <Pick label={t('settings.currency')} value={settings.currency} onSelect={(v) => void save({ currency: v })} className="w-[300px]" items={FIAT_CURRENCIES.map((c) => ({ value: c, label: currencyLabel(c), hint: c }))} />
          </Row>
          <Row label={t('settings.btcUnit')}>
            <Pick
              label={t('settings.btcUnit')}
              value={settings.btcUnit ?? 'btc'}
              onSelect={(v) => void save({ btcUnit: v })}
              items={[
                { value: 'btc', label: 'BTC', hint: t('settings.btcUnitBtcHint') },
                { value: 'sats', label: 'sats', hint: t('settings.btcUnitSatsHint') },
              ]}
            />
          </Row>
          <Row label={t('settings.hideSmall')} sub={t('settings.hideSmallDesc')}>
            <Pick
              label={t('settings.hideSmall')}
              value={settings.hideSmall ?? 'off'}
              onSelect={(v) => void save({ hideSmall: v })}
              className="w-[260px]"
              items={[
                { value: 'off', label: t('settings.hideSmallOff') },
                { value: 'zero', label: t('settings.hideSmallZero') },
                { value: 'under1', label: t('settings.hideSmallUnder', { amount: fmtFiat(1, settings.currency, { decimals: 0 }) }) },
                { value: 'under10', label: t('settings.hideSmallUnder', { amount: fmtFiat(10, settings.currency, { decimals: 0 }) }) },
              ]}
            />
          </Row>
        </Group>

        <Group title="Kyro">
          <Row label={t('settings.version')}>{store ? t('settings.versionStore', { version: __APP_VERSION__ }) : __APP_VERSION__}</Row>
          {!store && (
            <Row label={t('update.auto')}>
              <Switch label={t('update.auto')} on={settings.autoUpdate} onChange={(v) => void save({ autoUpdate: v })} />
            </Row>
          )}
          <Row label={t('welcome.sourceCode')}>GPL-3.0 · GitHub</Row>
        </Group>

        <Group title={t('settings.groupProtection')}>
          <Row label={t('settings.passwordEachTx')} sub={t('settings.passwordEachTxDesc')}>
            <Switch label={t('settings.passwordEachTx')} on disabled onChange={() => undefined} />
          </Row>
          <Row label={t('settings.captureProtection')} sub={t('settings.captureProtectionDesc')}>
            <Switch
              label={t('settings.captureProtection')}
              on={settings.captureProtection}
              onChange={(v) => {
                void save({ captureProtection: v });
                void call('set_capture_protection', { enabled: v }).catch(() => undefined);
              }}
            />
          </Row>
          <Row label={t('settings.clipboardGuard')} sub={t('settings.clipboardGuardDesc')}>
            <Switch label={t('settings.clipboardGuard')} on={settings.clipboardGuard} onChange={(v) => void save({ clipboardGuard: v })} />
          </Row>
          {config?.tray && (
            <Row label={t('settings.lockBeforeSleep')}>
              <Switch label={t('settings.lockBeforeSleep')} on={settings.lockBeforeSleep !== false} onChange={(v) => void save({ lockBeforeSleep: v })} />
            </Row>
          )}
          {!hwOnly && (
            <Row label={t('settings.contactsOnly')} sub={t('settings.contactsOnlyDesc')}>
              <Switch label={t('settings.contactsOnly')} on={settings.contactsOnly === true} onChange={(v) => (v ? void save({ contactsOnly: true }) : setContactsOff(true))} />
            </Row>
          )}
          <Row label={t('settings.spendAndSecond')} onClick={() => open('protection')} chevron />
        </Group>

        <Group title={t('settings.groupNetworks')}>
          <Row label={t('settings.sectionNetworks')} onClick={() => open('networks')} chevron />
          <Row label={t('settings.sectionConnections')} onClick={() => open('connections')} chevron>
            {tp('settings.connServers', hosts)}
          </Row>
          <Row label={t('settings.sectionApiKeys')} onClick={() => open('apikeys')} chevron />
        </Group>

        <Group title={t('settings.sectionAccounts')}>
          <Row label={t('settings.walletsAndAccounts')} onClick={() => open('accounts')} chevron />
          <Row label={t('settings.sectionHardware')} onClick={() => open('hardware')} chevron>
            Ledger · Trezor
          </Row>
          <Row label={t('settings.sectionContacts')} onClick={() => open('contacts')} chevron />
          <Row label={t('settings.sectionAlerts')} onClick={() => open('alerts')} chevron />
          <Row label={t('settings.sectionBackup')} onClick={() => open('backup')} chevron />
          {adapters?.xmr && <Row label={t('settings.moneroWallet')} onClick={() => open('monero')} chevron />}
        </Group>

        {config?.tray && (
          <Group title={t('settings.groupWindow')}>
            <Row label={t('settings.closeToTray')} sub={t('settings.closeToTrayDesc')}>
              <Switch label={t('settings.closeToTray')} on={settings.closeToTray} onChange={(v) => void save({ closeToTray: v })} />
            </Row>
            <Row label={t('settings.lockOnHide')} sub={t('settings.lockOnHideDesc')}>
              <Switch label={t('settings.lockOnHide')} on={settings.lockOnHide} onChange={(v) => void save({ lockOnHide: v })} />
            </Row>
            {config.autostart && (
              <Row label={t('settings.startMinimized')} sub={t('settings.startMinimizedDesc')}>
                <Switch label={t('settings.startMinimized')} on={settings.startMinimized} onChange={(v) => void save({ startMinimized: v })} />
              </Row>
            )}
          </Group>
        )}
      </div>
      <div className="mt-4 flex flex-col gap-3">{status}</div>
      <RevealPhrase open={reveal} onClose={() => setReveal(false)} />
      {contactsOff && (
        <PasswordGate
          title={t('settings.contactsOnlyOffTitle')}
          body={t('settings.contactsOnlyOffBody')}
          action={t('settings.contactsOnlyOffAction')}
          verify={async (password) => {
            await saveSettings(await call('contacts_only_off', { password }));
          }}
          onDone={() => setContactsOff(false)}
          onCancel={() => setContactsOff(false)}
        />
      )}
    </div>
  );
}

function Panel({ children, className, tone }: { children: ReactNode; className?: string; tone?: 'danger' }) {
  return <section className={cn('flex flex-col rounded-[18px] px-6 py-1.5 ring-1 backdrop-blur-xl', tone === 'danger' ? 'bg-down/[.04] ring-down/30' : 'bg-white/[.045] ring-white/[.07]', className)}>{children}</section>;
}

function SettingRow({ title, desc, children, last }: { title: string; desc: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-6 py-4', !last && 'border-b border-white/[.05]')}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13.5px] font-medium">{title}</span>
        <span className="text-[11.5px] text-faint">{desc}</span>
      </div>
      {children}
    </div>
  );
}

function Privacy() {
  const { settings, saveSettings } = useApp();
  const tor = useTor();
  const { t } = useT();
  const enabled = settings.tor.enabled;
  return (
    <>
      <Panel>
        <SettingRow title={t('settings.useTor')} desc={t('settings.useTorDesc')}>
          <Switch
            label={t('settings.useTor')}
            on={enabled}
            disabled={tor.busy}
            onChange={(v) => {
              if (v) void torStore.enable(() => saveSettings({ ...settings, tor: { ...settings.tor, enabled: true } }));
              else torStore.requestDisable('settings');
            }}
          />
        </SettingRow>
        <SettingRow title={t('settings.weeklyCount')} desc={t('settings.weeklyCountDesc')} last>
          <Switch label={t('settings.weeklyCount')} on={settings.weeklyCount} onChange={(v) => void saveSettings({ ...settings, weeklyCount: v })} />
        </SettingRow>
      </Panel>
      <Panel className="gap-3.5 py-5">
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 text-[13.5px] font-medium">
            <IconTor size={16} className="text-mute" /> {t('settings.connectionState')}
          </span>
          <span className="flex items-center gap-2 text-[13px] text-text2">
            {torIndicator(tor) === 'ready' ? (
              <>
                <IceDot /> {t('settings.torConnected')}
              </>
            ) : torIndicator(tor) === 'direct' ? (
              <span className="text-warn">{t('settings.torOff')}</span>
            ) : torIndicator(tor) === 'failed' ? (
              <span className="text-warn">{t('settings.torFailed')}</span>
            ) : (
              <span className="text-mute">{t('settings.torConnecting', { p: Math.max(0, Math.min(99, Math.round(tor.status?.progress ?? 0))) })}</span>
            )}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="flex flex-col gap-1.5 rounded-[14px] bg-white/[.03] px-4 py-3.5 ring-1 ring-white/[.05]">
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <IconCheck size={14} className="text-up" /> {t('settings.torHides')}
            </span>
            <span className="text-[12px] leading-[1.5] text-mute">{t('settings.torHidesDesc')}</span>
          </div>
          <div className="flex flex-col gap-1.5 rounded-[14px] bg-white/[.03] px-4 py-3.5 ring-1 ring-white/[.05]">
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <IconX size={14} className="text-warn" /> {t('settings.torDoesNotHide')}
            </span>
            <span className="text-[12px] leading-[1.5] text-mute">{t('settings.torDoesNotHideDesc')}</span>
          </div>
        </div>
        <p className="m-0 text-[12px] leading-[1.55] text-mute">{t('settings.torFailure')}</p>
        {!enabled && (
          <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
            {t('settings.directConnection')}
          </Notice>
        )}
        {tor.actionError && tor.dialog === 'none' && <Notice tone="error">{tor.actionError}</Notice>}
      </Panel>
      {enabled && <TorBridges />}
    </>
  );
}

function MoneroWallet() {
  const { adapters } = useVault();
  return <XmrWalletSection adapter={adapters.xmr} />;
}

/**
 * Rust checks the password, asks in a native window, then shows the words in another native
 * window: they never reach this interface (a compromised page could not read them).
 */
function RevealPhrase({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [wrong, setWrong] = useState(0);
  const { t } = useT();

  const close = () => {
    setPw('');
    setError(null);
    setShown(false);
    onClose();
  };
  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('vault_reveal_mnemonic', { password: pw });
      setPw('');
      setShown(true);
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') setWrong((n) => n + 1);
      else setError(err.code === 'USER_REJECTED' ? t('settings.revealCancelled') : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? undefined : close())} title={t('settings.recoveryPhrase')} className="w-[620px]">
      {!shown ? (
        <>
          <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
            {t('settings.revealWarn')}
          </Notice>
          <p className="m-0 text-[13px] leading-[1.55] text-text2">{t('settings.revealHow')}</p>
          <PasswordField id="reveal-pw" value={pw} onChange={setPw} autoFocus wrong={wrong} onEnter={() => pw && void reveal()} />
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={!pw || busy} onClick={() => void reveal()}>
              {busy && <Spinner />} {busy ? t('common.systemWindowOpen') : t('settings.revealButton')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <Notice tone="info">{t('settings.revealClosed')}</Notice>
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>
              {t('common.close')}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

/**
 * API keys are write-only (settings_get returns `apiKeysSet` only): a saved key shows « Saved ·
 * Remove · Replace », never its value.
 */
function ApiKeys() {
  const { settings, config } = useApp();
  const { t } = useT();
  // config flags are « environment OR saved key »: environment only when nothing is saved.
  const rows: Array<{ key: ApiKeyName; label: string; desc: string; env: boolean }> = [
    { key: 'coingecko', label: 'CoinGecko', desc: t('settings.apiCoingeckoDesc'), env: !!config?.hasCoingeckoKey && !settings.apiKeysSet.coingecko },
    { key: 'zerox', label: '0x', desc: t('settings.apiZeroxDesc'), env: !!config?.hasZeroxKey && !settings.apiKeysSet.zerox },
    { key: 'trongrid', label: 'TronGrid', desc: t('settings.apiTrongridDesc'), env: !!config?.hasTrongridKey && !settings.apiKeysSet.trongrid },
  ];
  return (
    <Panel>
      <div className="flex flex-col gap-1 border-b border-line py-4">
        <span className="text-[15px] font-medium tracking-[-0.01em]">{t('settings.sectionApiKeys')}</span>
        <span className="text-[13px] text-mute">{t('settings.apiKeysIntro')}</span>
      </div>
      {rows.map((r, i) => (
        <ApiKeyRow key={r.key} name={r.key} label={r.label} desc={r.desc} env={r.env} saved={!!settings.apiKeysSet[r.key]} last={i === rows.length - 1} />
      ))}
    </Panel>
  );
}

function ApiKeyRow({ name, label, desc, env, saved, last }: { name: ApiKeyName; label: string; desc: string; env: boolean; saved: boolean; last: boolean }) {
  const { settings, saveSettings } = useApp();
  const [editing, setEditing] = useState(!saved);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { t } = useT();
  useEffect(() => setEditing(!saved), [saved]);
  const write = async (v: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await saveSettings(settings, { [name]: v });
      setValue('');
      setDone(v ? t('settings.keySavedDone') : t('settings.keyDeletedDone'));
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };
  const typed = value.trim() !== '';
  return (
    <div className={cn('flex flex-col gap-2.5 py-4', !last && 'border-b border-line')} data-api-key={name}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-[14.5px] font-medium">
            {label} {env && <Badge tone="up">{t('settings.keyFromEnv')}</Badge>}
          </span>
          <span className="text-[13px] text-mute">{desc}</span>
        </div>
        {saved && !editing && (
          <span className="flex shrink-0 items-center gap-1.5 text-[13px]">
            <IconCheck size={14} className="text-up" />
            <span className="text-text2">{t('settings.keySaved')}</span>
            <span className="text-faint">·</span>
            <button type="button" disabled={busy} onClick={() => void write('')} className="text-mute hover:text-down disabled:opacity-45">
              {t('settings.removeKey')}
            </button>
            <span className="text-faint">·</span>
            <button type="button" disabled={busy} onClick={() => setEditing(true)} className="text-mute hover:text-text disabled:opacity-45">
              {t('settings.replace')}
            </button>
          </span>
        )}
      </div>
      {(!saved || editing) && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed && !busy) void write(value.trim());
          }}
        >
          <Input type="password" autoComplete="off" spellCheck={false} value={value} placeholder={saved ? t('settings.newKeyPlaceholder') : t('settings.pasteKey')} onChange={(e) => setValue(e.target.value)} aria-label={t('settings.apiKeyAria', { label })} className="flex-1 text-[13.5px]" />
          {typed && (
            <Button type="submit" variant="primary" size="sm" className="fade-in" disabled={busy}>
              {busy && <Spinner />} {t('common.save')}
            </Button>
          )}
          {saved && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setValue('');
              }}
              disabled={busy}
            >
              {t('common.cancel')}
            </Button>
          )}
        </form>
      )}
      {error && <span className="text-[12px] text-down">{error}</span>}
      {done && !error && <span className="fade-in text-[12px] text-up">{done}</span>}
    </div>
  );
}

type ConnGroup = 'prices' | 'chains' | 'swap' | 'updates' | 'other';
const CONN_GROUPS: Array<{ key: ConnGroup; label: Key }> = [
  { key: 'prices', label: 'settings.connGroupPrices' },
  { key: 'chains', label: 'settings.connGroupChains' },
  { key: 'swap', label: 'settings.connGroupSwap' },
  { key: 'updates', label: 'settings.connGroupUpdates' },
  { key: 'other', label: 'settings.connGroupOther' },
];

/** Sorts a host of `outgoingHosts` into a group, from its host name and purpose. */
function connGroup(h: { host: string; purpose: string }): ConnGroup {
  const s = `${h.host} ${h.purpose}`;
  if (/coingecko|\bprices?\b|\bprix\b/i.test(s)) return 'prices';
  if (/swap/i.test(h.purpose)) return 'swap';
  if (/update|mise à jour|mises à jour|github/i.test(s)) return 'updates';
  if (/: /.test(h.purpose)) return 'chains';
  return 'other';
}

/** "Bitcoin: balances, fees…" → "Bitcoin"; "EVM swap quotes (key required)" → "EVM swap quotes". */
function shortPurpose(p: string): string {
  return (p.split(/ ?: | \(/)[0] ?? p).trim();
}

function Connections({ compact }: { compact?: boolean }) {
  const { settings, network, navigate } = useApp();
  const hosts = outgoingHosts(network, settings.servers);
  const { t, tp } = useT();
  const groups = CONN_GROUPS.map((g) => ({ ...g, hosts: hosts.filter((h) => connGroup(h) === g.key) })).filter((g) => g.hosts.length > 0);
  const [open, setOpen] = useState<Partial<Record<ConnGroup, boolean>>>({});
  return (
    <section className="flex h-full flex-col gap-3 rounded-panel border border-line bg-card px-[22px] py-5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[15px] font-medium tracking-[-0.01em]">{t('settings.sectionConnections')}</span>
        <span className="text-[12px] text-mute">{tp('settings.connServers', hosts.length)}</span>
      </div>
      <p className="m-0 -mt-1.5 text-[13px] text-mute">{t('settings.connectionsIntro')}</p>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scroll-thin">
        {groups.map((g) => {
          const isOpen = open[g.key] ?? !compact;
          return (
            <div key={g.key} className="border-t border-line first:border-t-0">
              <button type="button" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [g.key]: !isOpen }))} className="flex h-10 w-full items-center gap-2 text-left text-[13.5px] font-medium text-text2 hover:text-text">
                <IconChevronRight size={14} className={cn('shrink-0 text-mute transition-transform duration-150', isOpen && 'rotate-90')} />
                <span className="flex-1">{(t as (k: Key) => string)(g.label)}</span>
                <span className="text-[12px] font-normal text-mute">{g.hosts.length}</span>
              </button>
              {isOpen && (
                <ul className="fade-in m-0 flex list-none flex-col p-0 pb-2.5 pl-[22px]">
                  {g.hosts.map((h) => (
                    <li key={h.host + h.purpose} title={h.purpose} className="flex min-w-0 items-center gap-2 py-1.5">
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] text-text">{h.host}</span>
                        <span className="truncate text-[12px] text-mute">{shortPurpose(h.purpose)}</span>
                      </span>
                      {h.custom && <Badge tone="ice">{t('settings.customBadge')}</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      {compact && (
        <Button variant="outline" size="lg" onClick={() => navigate({ name: 'settings', section: 'networks' })}>
          {t('settings.useOwnServers')}
        </Button>
      )}
    </section>
  );
}

function Contacts() {
  const { accounts, adapters } = useVault();
  const { accountSources } = useApp();
  const [list, setList] = useState<Contact[]>(() => getContacts());
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [pick, setPick] = useState<ContactFamily | null>(null);
  const [query, setQuery] = useState('');
  const { t } = useT();
  const candidates = useMemo(() => detectFamilies(address, adapterValidator(adapters)), [address, adapters]);
  const family: ContactFamily | undefined = pick && candidates.includes(pick) ? pick : candidates[0];
  const adapter = family ? familyAdapters(adapters, family)[0] : undefined;
  const valid = !!family;
  const persist = (l: Contact[]) => {
    setList(l);
    saveContacts(l);
  };
  // Address poisoning: a contact saved from a look-alike would become a « known » address.
  const lookalike = (() => {
    if (!family) return null;
    const own = [accounts.btc?.segwit.address, accounts.btc?.taproot.address, accounts.evm?.address, accounts.sol?.address, accounts.ltc?.address, accounts.doge?.address, accounts.bch?.address, accounts.dash?.address, accounts.tron?.address, accounts.xrp?.address, accounts.cardano?.address, accounts.stellar?.address, accounts.near?.address, accounts.sui?.address, accounts.kas?.address, accounts.polkadot?.address, accounts.algo?.address, accounts.xmr?.address, accounts.ton?.address, accounts.cosmos?.address, accounts.aptos?.address, accounts.zec?.address, ...accountSources.filter((x) => x.family === family).flatMap((x) => x.addresses)];
    const ownOfFamily = own.filter((a): a is string => !!a && (adapter?.isValidAddress(a) ?? false));
    const known: KnownAddress[] = [
      ...list.filter((c) => c.family === family).map((c) => ({ address: c.address, source: 'contact' as const, label: c.name })),
      ...ownOfFamily.map((a) => ({ address: a, source: 'own' as const, label: t('settings.yourAddress') })),
    ];
    return findLookalike(address.trim(), known, family);
  })();
  const [ack, setAck] = useState(false);
  useEffect(() => setAck(false), [address, family]);
  const canSave = valid && (!lookalike || ack);
  const contactGuard = useContactGuard();
  return (
    <Panel className="gap-4 py-5">
      {contactGuard.dialog}
      <span className="text-[15px] font-medium tracking-[-0.01em]">{t('settings.sectionContacts')}</span>
      <p className="m-0 -mt-2 text-[13px] text-mute">{t('settings.contactsIntro')}</p>
      <div className="flex flex-col gap-2">
        {list.length === 0 && <span className="text-[13px] text-faint">{t('settings.noContact')}</span>}
        {list.length > 5 && <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('settings.searchContacts')} aria-label={t('settings.searchContacts')} />}
        {list
          .filter((c) => !query.trim() || c.name.toLowerCase().includes(query.trim().toLowerCase()) || c.address.toLowerCase().includes(query.trim().toLowerCase()))
          .map((c) => (
            <div key={c.id} className="flex items-center gap-3 rounded-ctl bg-raised px-4 py-2.5">
              <CoinIcon symbol={CONTACT_FAMILY_META[c.family]?.symbol ?? c.family.toUpperCase()} size={30} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[14px] font-semibold">{c.name}</span>
                <span className="font-mono text-[12px] text-mute">{shortAddress(c.address)}</span>
              </span>
              <button type="button" aria-label={t('settings.deleteNamed', { name: c.name })} onClick={() => persist(list.filter((x) => x.id !== c.id))} className="flex size-8 items-center justify-center rounded-full text-mute hover:bg-control hover:text-down">
                <IconTrash size={15} />
              </button>
            </div>
          ))}
      </div>
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <span className="text-[13px] font-semibold">{t('common.add')}</span>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSave || !family) return;
            const entry: Contact = { id: crypto.randomUUID(), name: name.trim() || shortAddress(address.trim()), address: address.trim(), family, sends: 0 };
            contactGuard.guard(() => {
              persist([...getContacts(), entry]);
              setName('');
              setAddress('');
              setPick(null);
            });
          }}
        >
          <div className="flex items-center gap-2">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t('common.address')} aria-label={t('common.address')} className="min-w-0 flex-1 font-mono text-[13px]" />
            {family && candidates.length === 1 && (
              <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-raised py-1 pr-2.5 pl-1 text-[12px] font-semibold">
                <CoinIcon symbol={CONTACT_FAMILY_META[family].symbol} size={20} />
                {CONTACT_FAMILY_META[family].label}
              </span>
            )}
            {family && candidates.length > 1 && (
              <select value={family} onChange={(e) => setPick(e.target.value as ContactFamily)} aria-label={t('common.network')} className="h-[42px] shrink-0 rounded-ctl border border-line-3 bg-bg px-2 text-[13px] font-semibold">
                {candidates.map((f) => (
                  <option key={f} value={f}>
                    {CONTACT_FAMILY_META[f].label}
                  </option>
                ))}
              </select>
            )}
          </div>
          {address.trim() && !valid && <span className="text-[12px] text-down">{t('settings.invalidAddress')}</span>}
          {lookalike && family && <PoisoningWarning recipient={address.trim()} lookalike={lookalike} family={family} acknowledged={ack} onAcknowledge={setAck} />}
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.nameOptional')} aria-label={t('settings.name')} className="min-w-0 flex-1" />
            <Button type="submit" variant="primary" disabled={!canSave}>
              {t('settings.addToBook')}
            </Button>
          </div>
        </form>
      </div>
    </Panel>
  );
}
