// SPDX-License-Identifier: GPL-3.0-or-later
// Settings › Backup: contacts, labels and settings in one file encrypted with a password chosen
// here. Rust opens the native file windows, encrypts, decrypts and checks; this screen shows what an
// import would change and sends only what was ticked.

import { useMemo, useState, type ReactNode } from 'react';
import { call, toIpcError, type BackupPreview, type Settings } from '@kyro/shared';
import { applyLocal, collectLocal, planLocal, type LocalPlan } from '../../lib/backup';
import { adapterValidator } from '../../lib/contactDetect';
import { shortAddress } from '../../lib/format';
import { useApp, useVault } from '../../state/app';
import { PasswordField } from '../../components/kit';
import { Dialog } from '../../components/ui/dialog';
import { Button, Notice, Spinner, Switch } from '../../components/ui/primitives';
import { useT } from '../../i18n';

const MIN_LENGTH = 10;

const SETTING_NAMES = {
  currency: 'settings.currency',
  autoLockSecs: 'settings.autoLock',
  hideBalancesOnStart: 'settings.hideBalances',
  captureProtection: 'settings.captureProtection',
  clipboardGuard: 'settings.clipboardGuard',
  language: 'settings.language',
  autoUpdate: 'update.auto',
  weeklyCount: 'settings.weeklyCount',
  closeToTray: 'settings.closeToTray',
  lockOnHide: 'settings.lockOnHide',
} as const;

export function BackupSection() {
  return (
    <div className="flex flex-col gap-5">
      <Export />
      <Import />
    </div>
  );
}

function Card({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-panel border border-line bg-card px-6 py-5">
      <span className="text-[15px] font-medium tracking-[-0.01em]">{title}</span>
      <p className="m-0 text-[13px] leading-[1.55] text-text2">{intro}</p>
      {children}
    </section>
  );
}

function Export() {
  const { t } = useT();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const problem = password && password.length < MIN_LENGTH ? t('welcome.pwTooShort') : again && again !== password ? t('wallets.pwMismatch') : null;
  const ready = password.length >= MIN_LENGTH && password === again && !busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const done = await call('backup_export', { password, local: collectLocal() });
      if (done) {
        setSaved(true);
        setPassword('');
        setAgain('');
      }
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('settings.backupExport')} intro={t('settings.backupExportIntro')}>
      <PasswordField id="backup-pw" label={t('settings.backupPassword')} value={password} onChange={setPassword} autoComplete="new-password" />
      <PasswordField id="backup-pw-again" label={t('settings.backupPasswordAgain')} value={again} onChange={setAgain} autoComplete="new-password" onEnter={() => void submit()} />
      {problem && <span className="text-[12px] text-down">{problem}</span>}
      <p className="m-0 text-[12px] leading-[1.5] text-faint">{t('settings.backupForgotten')}</p>
      {error && <Notice tone="error">{error}</Notice>}
      {saved && <Notice>{t('settings.backupSaved')}</Notice>}
      <div className="flex justify-end">
        <Button variant="primary" disabled={!ready} onClick={() => void submit()}>
          {busy && <Spinner />} {t('settings.backupExportButton')}
        </Button>
      </div>
    </Card>
  );
}

function Import() {
  const { t } = useT();
  const { adapters } = useVault();
  const [file, setFile] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ preview: BackupPreview; plan: LocalPlan } | null>(null);
  const [done, setDone] = useState(false);
  const reset = () => {
    setFile(null);
    setPassword('');
    setError(null);
    setOpened(null);
  };
  const pick = async () => {
    setError(null);
    setDone(false);
    try {
      const name = await call('backup_pick');
      if (name !== null) {
        setFile(name);
        setPassword('');
      }
    } catch (e) {
      setError(toIpcError(e).message);
    }
  };
  const open = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const preview = await call('backup_open', { password });
      setOpened({ preview, plan: planLocal(preview.local, adapterValidator(adapters)) });
      setPassword('');
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') {
        setWrong((n) => n + 1);
        setError(t('settings.backupWrongPassword'));
      } else setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    void call('backup_cancel').catch(() => undefined);
    reset();
  };
  return (
    <Card title={t('settings.backupImport')} intro={t('settings.backupImportIntro')}>
      {file && (
        <>
          <span className="truncate text-[13px] text-text2">{file}</span>
          <PasswordField id="backup-open-pw" label={t('settings.backupPassword')} value={password} onChange={setPassword} wrong={wrong} onEnter={() => void open()} />
        </>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {done && <Notice>{t('settings.backupImported')}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={() => void pick()} disabled={busy}>
          {t('settings.backupChoose')}
        </Button>
        {file && (
          <Button variant="primary" disabled={!password || busy} onClick={() => void open()}>
            {busy && <Spinner />} {t('settings.backupOpen')}
          </Button>
        )}
      </div>
      {opened && (
        <Review
          preview={opened.preview}
          plan={opened.plan}
          onCancel={cancel}
          onDone={() => {
            reset();
            setDone(true);
          }}
        />
      )}
    </Card>
  );
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between text-[13px]">
      <span className="text-text2">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function Choice({ title, checked, onChange, children }: { title: string; checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[13.5px] font-medium">{title}</span>
        <Switch label={title} checked={checked} onCheckedChange={onChange} />
      </div>
      {children}
    </div>
  );
}

function Review({ preview, plan, onCancel, onDone }: { preview: BackupPreview; plan: LocalPlan; onCancel: () => void; onDone: () => void }) {
  const { t } = useT();
  const { saveSettings, refreshVaultAccounts, refreshWatchAddresses } = useApp();
  const newCount = plan.addContacts.length + preview.watch.add.length + preview.labels.add.length + plan.addFavorites.length + plan.addAlerts.length + (plan.turnOnReceived ? 1 : 0);
  const renames = useMemo(
    () => [
      ...plan.renameContacts.map((r) => ({ id: `c${r.id}`, where: shortAddress(r.address), current: r.current, backup: r.backup })),
      ...preview.watch.rename.map((r) => ({ id: `w${r.family}${r.value}`, where: shortAddress(r.value), current: r.current, backup: r.backup })),
      ...preview.labels.rename.map((r) => ({ id: `l${r.chain}${r.index}`, where: r.chain.toUpperCase(), current: r.current, backup: r.backup })),
    ],
    [plan, preview],
  );
  const [add, setAdd] = useState(newCount > 0);
  const [replaceNames, setReplaceNames] = useState(false);
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = (v: unknown): string => (v === true ? t('settings.backupOn') : v === false ? t('settings.backupOff') : String(v));
  const leftOut = plan.invalidContacts + plan.lookalikeContacts + preview.watch.refused;
  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const next: Settings = await call('backup_apply', { choices: { addWatch: add, addLabels: add, replaceNames, settings } });
      applyLocal(plan, { add, replaceNames });
      await Promise.all([refreshVaultAccounts(), refreshWatchAddresses()]);
      if (settings) await saveSettings(next);
      onDone();
    } catch (e) {
      setError(toIpcError(e).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onCancel()} title={t('settings.backupReviewTitle')} description={t('settings.backupReviewIntro', { date: new Date(preview.createdAt).toLocaleDateString() })}>
      <div className="flex max-h-[52vh] flex-col gap-3 overflow-y-auto pr-1 scroll-thin">
        {preview.otherNetwork && <Notice>{t('settings.backupOtherNetwork')}</Notice>}
        <Choice title={t('settings.backupAddNew')} checked={add} onChange={setAdd}>
          <Line label={t('settings.backupContacts')} value={plan.addContacts.length} />
          <Line label={t('settings.backupWatch')} value={preview.watch.add.length} />
          <Line label={t('settings.backupLabels')} value={preview.labels.add.length} />
          <Line label={t('settings.backupFavorites')} value={plan.addFavorites.length} />
          <Line label={t('settings.backupAlerts')} value={plan.addAlerts.length + (plan.turnOnReceived ? 1 : 0)} />
        </Choice>
        {renames.length > 0 && (
          <Choice title={t('settings.backupReplaceNames', { n: renames.length })} checked={replaceNames} onChange={setReplaceNames}>
            {renames.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 text-[12.5px]">
                <span className="shrink-0 font-mono text-mute">{r.where}</span>
                <span className="min-w-0 truncate text-text2">
                  {r.current} → {r.backup}
                </span>
              </div>
            ))}
          </Choice>
        )}
        {preview.settings.length > 0 && (
          <Choice title={t('settings.backupReplaceSettings', { n: preview.settings.length })} checked={settings} onChange={setSettings}>
            {preview.settings.map((s) => {
              const name = (SETTING_NAMES as Record<string, (typeof SETTING_NAMES)[keyof typeof SETTING_NAMES] | undefined>)[s.key];
              return (
                <div key={s.key} className="flex items-center justify-between gap-3 text-[12.5px]">
                  <span className="min-w-0 truncate text-mute">{name ? t(name) : s.key}</span>
                  <span className="shrink-0 text-text2">
                    {shown(s.current)} → {shown(s.backup)}
                  </span>
                </div>
              );
            })}
          </Choice>
        )}
        {leftOut > 0 && <p className="m-0 text-[12px] leading-[1.5] text-faint">{t('settings.backupLeftOut', { n: leftOut })}</p>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={busy || (!add && !replaceNames && !settings)} onClick={() => void apply()}>
          {busy && <Spinner />} {t('settings.backupApply')}
        </Button>
      </div>
    </Dialog>
  );
}
