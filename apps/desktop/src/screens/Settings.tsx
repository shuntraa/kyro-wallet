// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { call, toIpcError, type AccountChain, type ApiKeyName, type Settings } from '@kyro/shared';
import { findLookalike, isHiddenFamily, outgoingHosts, type KnownAddress } from '@kyro/chains';
import { useApp, useVault, type SettingsSection } from '../state/app';
import { cn } from '../lib/cn';
import { shortAddress } from '../lib/format';
import { getBackupState, getContacts, saveContacts, type Contact, type ContactFamily } from '../lib/storage';
import { PasswordField } from '../components/kit';
import { PoisoningWarning } from '../components/Poisoning';
import { ServersSection } from './settings/Servers';
import { NetDiagnostics } from './settings/Diagnostics';
import { Devices } from './settings/Devices';
import { AccountsSection } from './settings/Accounts';
import { Dialog } from '../components/ui/dialog';
import { Badge, Button, Input, Notice, Segmented, Spinner, Switch } from '../components/ui/primitives';
import { IconCheck, IconChevronRight, IconEye, IconTor, IconTrash, IconWarn, IconX } from '../components/icons';
import { TorIndicator } from '../components/Tor';
import { torStore, useTor } from '../state/tor';
import { useMedia } from '../components/motion';
import { useT, type Key } from '../i18n';
import { XmrWalletSection } from '../components/Monero';
import { CurrencySelect } from '../components/CurrencySelect';

const SECTIONS: Array<{ key: SettingsSection; label: Key }> = [
  { key: 'security', label: 'settings.sectionSecurity' },
  { key: 'privacy', label: 'settings.sectionPrivacy' },
  { key: 'accounts', label: 'settings.sectionAccounts' },
  { key: 'hardware', label: 'settings.sectionHardware' },
  { key: 'networks', label: 'settings.sectionNetworks' },
  { key: 'display', label: 'settings.sectionDisplay' },
  { key: 'apikeys', label: 'settings.sectionApiKeys' },
  { key: 'connections', label: 'settings.sectionConnections' },
  { key: 'contacts', label: 'settings.sectionContacts' },
];

export function SettingsScreen({ section: initial = 'security', family }: { section?: SettingsSection; family?: AccountChain }) {
  const [section, setSection] = useState<SettingsSection>(initial);
  const { settings, saveSettings } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { t } = useT();
  // Below 1280 px the outgoing-connections summary moves under the section instead of squeezing it
  // into a 300 px column.
  const wide = useMedia('(min-width: 1280px)');

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

  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label={t('settings.sectionsNav')} className="flex w-[240px] shrink-0 flex-col gap-0.5 border-r border-rail px-3.5 pt-6 pb-5">
        <h1 className="screen-title px-2.5 pb-5">{t('common.settings')}</h1>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-current={section === s.key ? 'page' : undefined}
            onClick={() => setSection(s.key)}
            className={cn('group relative flex h-10 items-center gap-3 rounded-ctl px-3 text-left text-[14px] transition-colors duration-150', section === s.key ? 'font-medium text-text' : 'text-mute hover:text-text2')}
          >
            {section === s.key && (
              <motion.span layoutId="settings-section" aria-hidden="true" className="absolute inset-0 rounded-ctl border border-line-2 bg-raised" transition={{ type: 'spring', stiffness: 520, damping: 42 }}>
                <span className="absolute top-1/2 left-0 h-4 w-[2px] -translate-y-1/2 rounded-full bg-ice" />
              </motion.span>
            )}
            <span className="relative z-10 truncate">{(t as (k: Key) => string)(s.label)}</span>
          </button>
        ))}
        <div className="flex-1" />
        <div className="border-t border-line px-2.5 pt-4 text-[12px] text-mute">Kyro {__APP_VERSION__}</div>
      </nav>

      <div className="flex min-w-0 flex-1 gap-6 px-8 pt-7 pb-6">
        <div key={section} className="rise flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto scroll-thin">
          {error && <Notice tone="error">{error}</Notice>}
          {section === 'security' && <Security save={save} />}
          {section === 'privacy' && <Privacy />}
          {section === 'accounts' && <AccountsSection {...(family ? { family } : {})} />}
          {section === 'hardware' && <Devices />}
          {section === 'networks' && (
            <>
              <NetDiagnostics />
              <ServersSection />
            </>
          )}
          {section === 'display' && <Display save={save} />}
          {section === 'apikeys' && <ApiKeys />}
          {section === 'connections' && <Connections />}
          {section === 'contacts' && <Contacts />}
          {saved && <span className="fade-in text-[12px] text-up">✓ {t('settings.saved')}</span>}
          {section !== 'connections' && section !== 'accounts' && !wide && (
            <div className="shrink-0">
              <Connections compact />
            </div>
          )}
        </div>
        {section !== 'connections' && section !== 'accounts' && wide && (
          <aside className="w-[400px] shrink-0">
            <Connections compact />
          </aside>
        )}
      </div>
    </div>
  );
}

type Save = (patch: Partial<Settings>) => Promise<void>;

function Panel({ children, className, tone }: { children: ReactNode; className?: string; tone?: 'danger' }) {
  return <section className={cn('flex flex-col rounded-panel border bg-card px-6 py-1.5', tone === 'danger' ? 'border-down/30' : 'border-line', className)}>{children}</section>;
}

function SettingRow({ title, desc, children, last }: { title: string; desc: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-6 py-4', !last && 'border-b border-line')}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14.5px] font-medium">{title}</span>
        <span className="text-[13px] text-mute">{desc}</span>
      </div>
      {children}
    </div>
  );
}

function Security({ save }: { save: Save }) {
  const { settings } = useApp();
  const { t } = useT();
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
  return (
    <>
      <Panel>
        <SettingRow title={t('settings.autoLock')} desc={t('settings.autoLockDesc')}>
          <Segmented
            label={t('settings.autoLockDelay')}
            value={settings.autoLockSecs}
            onChange={(v) => void save({ autoLockSecs: v })}
            options={[300, 900, 1800, 3600].map((s) => ({ value: s, label: s === 3600 ? '1 h' : `${s / 60} min` }))}
          />
        </SettingRow>
        <SettingRow title={t('settings.passwordEachTx')} desc={t('settings.passwordEachTxDesc')}>
          <Switch label={t('settings.passwordEachTx')} checked disabled />
        </SettingRow>
        <SettingRow title={t('settings.captureProtection')} desc={t('settings.captureProtectionDesc')}>
          <Switch
            label={t('settings.captureProtection')}
            checked={settings.captureProtection}
            onCheckedChange={(v) => {
              void save({ captureProtection: v });
              void call('set_capture_protection', { enabled: v }).catch(() => undefined);
            }}
          />
        </SettingRow>
        <SettingRow title={t('settings.clipboardGuard')} desc={t('settings.clipboardGuardDesc')}>
          <Switch label={t('settings.clipboardGuard')} checked={settings.clipboardGuard} onCheckedChange={(v) => void save({ clipboardGuard: v })} />
        </SettingRow>
        <SettingRow title={t('settings.hideBalances')} desc={t('settings.hideBalancesSecurityDesc')} last>
          <Switch label={t('settings.hideBalances')} checked={settings.hideBalancesOnStart} onCheckedChange={(v) => void save({ hideBalancesOnStart: v })} />
        </SettingRow>
      </Panel>
      <Panel>
        {store ? (
          <SettingRow title={t('update.title')} desc={t('update.store', { version: __APP_VERSION__ })} last>
            {null}
          </SettingRow>
        ) : (
          <SettingRow title={t('update.auto')} desc={t('update.autoDesc', { version: __APP_VERSION__ })} last>
            <Switch label={t('update.auto')} checked={settings.autoUpdate} onCheckedChange={(v) => void save({ autoUpdate: v })} />
          </SettingRow>
        )}
      </Panel>
      <RevealPhrase />
      <MoneroWallet />
    </>
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
            checked={enabled}
            disabled={tor.busy}
            onCheckedChange={(v) => {
              if (v) void torStore.enable(() => saveSettings({ ...settings, tor: { enabled: true } }));
              else torStore.requestDisable('settings');
            }}
          />
        </SettingRow>
        <SettingRow title={t('settings.weeklyCount')} desc={t('settings.weeklyCountDesc')} last>
          <Switch label={t('settings.weeklyCount')} checked={settings.weeklyCount} onCheckedChange={(v) => void saveSettings({ ...settings, weeklyCount: v })} />
        </SettingRow>
      </Panel>
      <section className="flex flex-col gap-3.5 rounded-panel border border-line bg-card px-[22px] py-[18px]">
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
            <IconTor size={16} className="text-mute" /> {t('settings.connectionState')}
          </span>
          <span className="font-mono text-[12px]">
            <TorIndicator />
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="flex flex-col gap-1.5 rounded-box border border-line bg-raised px-4 py-3.5">
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <IconCheck size={14} className="text-up" /> {t('settings.torHides')}
            </span>
            <span className="text-[12px] leading-[1.5] text-mute">{t('settings.torHidesDesc')}</span>
          </div>
          <div className="flex flex-col gap-1.5 rounded-box border border-line bg-raised px-4 py-3.5">
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
      </section>
    </>
  );
}

function MoneroWallet() {
  const { adapters } = useVault();
  return <XmrWalletSection adapter={adapters.xmr} />;
}

function RevealPhrase() {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [wrong, setWrong] = useState(0);
  const { t } = useT();
  const backup = getBackupState();

  const close = () => {
    setPw('');
    setError(null);
    setShown(false);
    setOpen(false);
  };
  // Rust checks the password, asks in a native window, then shows the words in another native
  // window: they never reach this interface (a compromised page could not read them).
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
    <section className="flex items-center gap-4 rounded-panel border border-down/30 bg-card px-[22px] py-[18px]">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-ctl bg-down/12 text-down">
        <IconEye size={18} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-[14px] font-semibold">
          {t('settings.recoveryPhrase')} {backup === 'unknown' && <Badge tone="warn">{t('settings.backupUnverified')}</Badge>}
        </span>
        <span className="text-[12px] leading-[1.5] text-mute">{t('settings.revealDesc')}</span>
      </div>
      <Button variant="dangerOutline" size="md" onClick={() => setOpen(true)}>
        {t('common.show')}
      </Button>
      <Button variant="outline" size="md" disabled title={t('settings.changePasswordSoon')}>
        {t('common.password')}
      </Button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : close())} title={t('settings.recoveryPhrase')} className="w-[620px]">
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
    </section>
  );
}

function Display({ save }: { save: Save }) {
  const { settings } = useApp();
  const { t } = useT();
  return (
    <Panel>
      <SettingRow title={t('settings.language')} desc={t('settings.languageDesc')}>
        <Segmented
          label={t('settings.language')}
          value={settings.language}
          onChange={(v) => void save({ language: v })}
          options={[
            { value: 'auto', label: t('settings.languageAuto') },
            { value: 'fr', label: t('settings.languageFr') },
            { value: 'en', label: t('settings.languageEn') },
          ]}
        />
      </SettingRow>
      <SettingRow title={t('settings.currency')} desc={t('settings.currencyDesc')}>
        <CurrencySelect label={t('settings.currency')} value={settings.currency} onChange={(v) => void save({ currency: v })} />
      </SettingRow>
      <SettingRow title={t('settings.hideBalances')} desc={t('settings.hideBalancesDisplayDesc')} last>
        <Switch label={t('settings.hideBalances')} checked={settings.hideBalancesOnStart} onCheckedChange={(v) => void save({ hideBalancesOnStart: v })} />
      </SettingRow>
    </Panel>
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
  const [family, setFamily] = useState<ContactFamily>('evm');
  const { t } = useT();
  const adapter = family === 'evm' ? [...adapters.evm.values()][0] : family === 'ada' ? adapters.cardano : family === 'xlm' ? adapters.stellar : family === 'kas' ? adapters.kaspa : family === 'dot' ? adapters.polkadot : family === 'apt' ? adapters.aptos : adapters[family];
  const valid = !!adapter && adapter.isValidAddress(address.trim());
  const persist = (l: Contact[]) => {
    setList(l);
    saveContacts(l);
  };
  // Address poisoning: a contact saved from a look-alike would become a « known » address.
  const lookalike = (() => {
    if (!valid) return null;
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
  return (
    <Panel className="gap-4 py-5">
      <span className="text-[15px] font-medium tracking-[-0.01em]">{t('settings.sectionContacts')}</span>
      <p className="m-0 -mt-2 text-[13px] text-mute">{t('settings.contactsIntro')}</p>
      <div className="flex flex-col gap-2">
        {list.length === 0 && <span className="text-[13px] text-faint">{t('settings.noContact')}</span>}
        {list.map((c) => (
          <div key={c.id} className="flex items-center gap-3 rounded-ctl bg-raised px-4 py-2.5">
            <span className="flex size-8 items-center justify-center rounded-full bg-ice-deep text-[13px] font-semibold text-ice-text">{c.name.slice(0, 1).toUpperCase()}</span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[14px] font-semibold">{c.name}</span>
              <span className="font-mono text-[12px] text-mute">
                {c.family.toUpperCase()} · {shortAddress(c.address)}
              </span>
            </span>
            <button type="button" aria-label={t('settings.deleteNamed', { name: c.name })} onClick={() => persist(list.filter((x) => x.id !== c.id))} className="flex size-8 items-center justify-center rounded-full text-mute hover:bg-control hover:text-down">
              <IconTrash size={15} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <span className="text-[13px] font-semibold">{t('common.add')}</span>
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.name')} className="w-[160px]" />
          <Segmented label={t('common.network')} value={family} onChange={(v) => setFamily(v as ContactFamily)} options={[{ value: 'evm', label: 'EVM' }, { value: 'btc', label: 'BTC' }, { value: 'sol', label: 'SOL' }, { value: 'ltc', label: 'LTC' }, { value: 'doge', label: 'DOGE' }, { value: 'bch', label: 'BCH' }, { value: 'dash', label: 'DASH' }, { value: 'tron', label: 'TRON' }, { value: 'xrp', label: 'XRP' }, { value: 'ada', label: 'ADA' }, { value: 'zec', label: 'ZEC' }, { value: 'apt', label: 'APT' }, { value: 'cosmos', label: 'ATOM' }, { value: 'ton', label: 'TON' }, { value: 'xmr', label: 'XMR' }, { value: 'algo', label: 'ALGO' }, { value: 'dot', label: 'DOT' }, { value: 'kas', label: 'KAS' }, { value: 'hbar', label: 'HBAR' }, { value: 'sui', label: 'SUI' }, { value: 'xlm', label: 'XLM' }, { value: 'near', label: 'NEAR' }].filter((o) => !isHiddenFamily(o.value))} />
        </div>
        <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t('common.address')} className="font-mono text-[13px]" />
        {address && !valid && <span className="text-[12px] text-down">{t('settings.invalidAddress')}</span>}
        {lookalike && <PoisoningWarning recipient={address.trim()} lookalike={lookalike} family={family} acknowledged={ack} onAcknowledge={setAck} />}
        <div>
          <Button
            variant="primary"
            disabled={!name.trim() || !valid || (!!lookalike && !ack)}
            onClick={() => {
              persist([...list, { id: crypto.randomUUID(), name: name.trim(), address: address.trim(), family, sends: 0 }]);
              setName('');
              setAddress('');
            }}
          >
            {t('settings.addToBook')}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
