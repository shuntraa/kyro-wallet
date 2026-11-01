// SPDX-License-Identifier: GPL-3.0-or-later
//
// Embedded Tor, visible side: status-bar indicator, failure dialog, "continue
// without Tor" confirmation, and the inline "waiting for Tor" state of data screens.
// State and rules: ../state/tor.ts (never a silent switch to clear).

import { isTorUnavailable } from '@kyro/shared';
import { useApp } from '../state/app';
import { torDetail, torIndicator, torStore, torWaiting, useTor } from '../state/tor';
import { cn } from '../lib/cn';
import { Dialog } from './ui/dialog';
import { Button, Notice, Spinner } from './ui/primitives';
import { IconGlobe, IconRefresh, IconShield, IconTor, IconWarn } from './icons';
import { useT } from '../i18n';
import { rt } from '../i18n/rich';

const NNBSP = ' ';

/** Compact Tor state for the status bar (always visible, every phase). */
export function TorIndicator() {
  const tor = useTor();
  const { phase, navigate } = useApp();
  const kind = torIndicator(tor);
  const { t } = useT();
  const base = 'flex items-center gap-1.5 whitespace-nowrap';

  switch (kind) {
    case 'unknown':
      return (
        <span className={cn(base, 'text-mute')} title={t('shell.torReading')}>
          <IconTor size={12} className="text-faint" /> Tor · …
        </span>
      );
    case 'bootstrapping': {
      const p = Math.max(0, Math.min(99, Math.round(tor.status?.progress ?? 0)));
      return (
        <span role="status" aria-label={t('shell.torBootAria', { p })} className={cn(base, 'text-mute')} title={t('shell.torBootTitle')}>
          <IconTor size={12} className="animate-pulse text-faint" />
          <span className="tabular-nums">
            Tor · {p}
            {NNBSP}%
          </span>
        </span>
      );
    }
    case 'ready':
      return (
        <span role="status" className={cn(base, 'text-ice')} title={t('shell.torReadyTitle')}>
          <IconTor size={12} /> {t('shell.torActive')}
        </span>
      );
    case 'failed':
      return (
        <button
          type="button"
          onClick={() => torStore.openFailure()}
          className={cn(base, 'h-5 rounded-full bg-down/12 px-2 font-semibold text-down hover:bg-down/20')}
          title={t('shell.torFailedTitle')}
        >
          <IconWarn size={12} /> {t('shell.torUnavailable')}
        </button>
      );
    case 'direct': {
      const label = (
        <>
          <IconGlobe size={12} /> {t('shell.directNoTor')}
        </>
      );
      const title = t('shell.directTitle');
      const cls = cn(base, 'h-5 rounded-full bg-warn/14 px-2 font-semibold text-warn');
      return phase === 'ready' ? (
        <button type="button" onClick={() => navigate({ name: 'settings', section: 'privacy' })} className={cn(cls, 'hover:bg-warn/20')} title={`${title} ${t('shell.directTitleClick')}`}>
          {label}
        </button>
      ) : (
        <span className={cls} title={title}>
          {label}
        </span>
      );
    }
  }
}

/** True when a data error should read "waiting for Tor" rather than a generic failure. */
export function useTorBlocked(error?: unknown): boolean {
  const tor = useTor();
  if (tor.enabled === false) return false;
  return torWaiting(tor) || (error !== undefined && error !== null && isTorUnavailable(error));
}

/** Inline state of a data screen blocked by Tor (instead of a generic error). */
export function TorWait({ className }: { className?: string }) {
  const tor = useTor();
  const failed = torIndicator(tor) === 'failed';
  const { t } = useT();
  return (
    <div role="status" className={cn('flex items-center gap-2 text-[12px] text-mute', className)}>
      {failed ? <IconTor size={14} className="shrink-0 text-faint" /> : <Spinner className="size-3 shrink-0 border-[1.5px] text-faint" />}
      <span className="min-w-0 flex-1">
        {t('shell.waitingTor')}
        <span className="text-faint"> {failed ? t('shell.torFailedInline') : t('shell.torDataSoon')}</span>
      </span>
      {failed && (
        <button type="button" onClick={() => torStore.openFailure()} className="shrink-0 font-semibold text-ice hover:underline">
          {t('shell.whatToDo')}
        </button>
      )}
    </div>
  );
}

/** What servers see without Tor: shared by the failure flow and the settings switch. */
export function DirectConnectionWarning() {
  useT();
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
      <p className="m-0">
        {rt('shell.directWarnIntro', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
      </p>
      <ul className="m-0 mt-1.5 flex list-disc flex-col gap-0.5 pl-5">
        <li>{rt('shell.directWarnNodes')}</li>
        <li>{rt('shell.directWarnApis')}</li>
        <li>{rt('shell.directWarnIsp')}</li>
      </ul>
    </Notice>
  );
}

/** Failure dialog + explicit confirmation. Mounted once, at the root of the app. */
export function TorDialogs() {
  const tor = useTor();
  const { settings, saveSettings } = useApp();
  const detail = torDetail(tor.episode?.reason ?? tor.status?.message);
  const { t } = useT();

  return (
    <>
      <Dialog open={tor.dialog === 'failure'} onOpenChange={(v) => (v ? undefined : torStore.cancel())} title={t('shell.torFailTitle')} className="w-[560px]">
        <p className="m-0 text-[14px] leading-[1.55] text-text2">{t('shell.torFailBody')}</p>
        <Notice icon={<IconShield size={16} className="mt-0.5 shrink-0 text-ice" />}>
          {rt('shell.torRefusesClear', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}
        </Notice>
        {detail && <p className="m-0 font-mono text-[11px] leading-[1.5] break-words text-faint">{t('shell.detail', { detail })}</p>}
        {tor.actionError && <Notice tone="error">{tor.actionError}</Notice>}
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" onClick={() => torStore.requestDisable('failure')} disabled={tor.busy}>
            {t('shell.continueWithoutTor')}
          </Button>
          <div className="flex gap-2">
            <Button onClick={() => torStore.cancel()} disabled={tor.busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void torStore.retry()} disabled={tor.busy}>
              {tor.busy ? <Spinner /> : <IconRefresh size={15} />} {t('common.retry')}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={tor.dialog === 'confirm-direct'}
        onOpenChange={(v) => (v ? undefined : torStore.cancelDisable())}
        title={t('shell.confirmDirectTitle')}
        description={t('shell.confirmDirectDesc')}
        className="w-[560px]"
      >
        <DirectConnectionWarning />
        <p className="m-0 text-[13px] leading-[1.55] text-mute">{t('shell.torStaysOff')}</p>
        {tor.actionError && <Notice tone="error">{tor.actionError}</Notice>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="primary" onClick={() => torStore.cancelDisable()} disabled={tor.busy}>
            {t('shell.keepTor')}
          </Button>
          <Button variant="dangerOutline" disabled={tor.busy} onClick={() => void torStore.confirmDisable(() => saveSettings({ ...settings, tor: { enabled: false } }))}>
            {tor.busy && <Spinner />} {t('shell.yesWithoutTor')}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
