// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useState } from 'react';
import { fmtCountdown } from '../lib/format';
import { getApprovals, getBackupState } from '../lib/storage';
import { hwFingerprint } from '@kyro/chains';
import { useApp } from '../state/app';
import { IconShield, IconUsbKey } from './icons';
import { Badge } from './ui/primitives';
import { DeviceBadge } from './hw';
import { useT } from '../i18n';

export function VaultCard() {
  const { status, network, navigate, activeHw, hwAccounts } = useApp();
  const { t, tp } = useT();
  const [left, setLeft] = useState<number | null>(status?.lockInSecs ?? null);

  useEffect(() => {
    setLeft(status?.lockInSecs ?? null);
    if (status?.lockInSecs === null || status?.lockInSecs === undefined) return;
    const t0 = Date.now();
    const base = status.lockInSecs;
    const id = window.setInterval(() => setLeft(Math.max(0, base - Math.floor((Date.now() - t0) / 1000))), 1000);
    return () => window.clearInterval(id);
  }, [status]);

  const unlimited = useMemo(() => getApprovals(network).filter((a) => a.unlimited).length, [network]);
  const backup = getBackupState();
  const pct = status && left !== null && status.autoLockSecs > 0 ? Math.min(100, (left / status.autoLockSecs) * 100) : 0;

  if (activeHw) {
    // Hardware-wallet account: no key in Kyro, nothing to lock here.
    return (
      <section aria-label="Hardware wallet" className="flex flex-1 flex-col gap-3.5 px-5 pt-4 pb-[18px]">
        <div className="flex items-center gap-3">
          <IconUsbKey size={18} className="shrink-0 text-ice" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[15px] font-medium tracking-[-0.01em]">{activeHw.label}</span>
            <span className="text-[12px] text-mute">{t('shell.hwKeysInDevice')}</span>
          </span>
          <DeviceBadge device={activeHw.device} model={activeHw.model} />
        </div>
        <div className="flex flex-col text-[13px]">
          <Row label={t('shell.fingerprint')}>
            <span className="font-mono text-[12px]">{hwFingerprint(activeHw) ?? '—'}</span>
          </Row>
          <Row label={t('common.account')}>
            <span className="font-semibold">{t('shell.accountNo', { n: activeHw.account })}</span>
          </Row>
          <Row label={t('shell.unlimitedApprovals')}>
            <button type="button" onClick={() => navigate({ name: 'history' })} className={unlimited ? 'font-semibold text-down hover:underline' : 'font-semibold text-up'}>
              {unlimited ? tp('shell.activeApprovals', unlimited) : t('shell.noneFem')}
            </button>
          </Row>
          <Row label={t('shell.devices')}>
            <button type="button" onClick={() => navigate({ name: 'settings', section: 'hardware' })} className="font-semibold text-ice hover:underline">
              {t('shell.manage')}
            </button>
          </Row>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={t('shell.vault')} className="flex flex-1 flex-col gap-3.5 px-5 pt-4 pb-[18px]">
      <div className="flex items-center gap-3">
        <IconShield size={18} sw={1.8} className="shrink-0 text-ice" />
        <span className="flex flex-1 flex-col">
          <span className="text-[15px] font-medium tracking-[-0.01em]">{t('shell.vault')}</span>
          <span className="text-[12px] text-mute">{t('shell.vaultEncrypted')}</span>
        </span>
        <Badge tone={status?.unlocked ? 'up' : 'mute'}>
          {status?.unlocked ? t('shell.unlocked') : t('shell.locked')}
        </Badge>
      </div>
      <div className="flex flex-col gap-[7px]">
        <div className="flex justify-between text-[12px]">
          <span className="text-mute">{t('shell.autoLock')}</span>
          <span className="font-mono text-text2">{left !== null ? fmtCountdown(left) : '—'}</span>
        </div>
        <div className="h-[3px] overflow-hidden rounded-full bg-control-2">
          <div className="h-full rounded-full bg-ice transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="flex flex-col text-[13px]">
        <Row label="Hardware wallet">
          <button type="button" onClick={() => navigate({ name: 'settings', section: 'hardware' })} className="font-semibold text-ice hover:underline">
            {hwAccounts.length ? tp('shell.hwAccounts', hwAccounts.length) : t('common.add')}
          </button>
        </Row>
        <Row label={t('shell.unlimitedApprovals')}>
          <button type="button" onClick={() => navigate({ name: 'history' })} className={unlimited ? 'font-semibold text-down hover:underline' : 'font-semibold text-up'}>
            {unlimited ? tp('shell.activeApprovals', unlimited) : t('shell.noneFem')}
          </button>
        </Row>
        <Row label={t('shell.recoveryPhrase')}>
          {backup === 'confirmed' ? (
            <span className="font-semibold text-up">{t('shell.backedUp')}</span>
          ) : backup === 'imported' ? (
            <span className="font-semibold text-up">{t('shell.imported')}</span>
          ) : (
            <button type="button" onClick={() => navigate({ name: 'settings', section: 'security' })} className="font-semibold text-warn hover:underline">
              {t('shell.notVerified')}
            </button>
          )}
        </Row>
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-9 items-center justify-between border-t border-line">
      <span className="text-text2">{label}</span>
      {children}
    </div>
  );
}
