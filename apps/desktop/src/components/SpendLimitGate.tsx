// SPDX-License-Identifier: GPL-3.0-or-later
// The screen shown when Rust refuses a signature with SPEND_LIMIT, whichever screen started it, and
// the override steps it shares with Settings. Rust decides; this only asks.

import { useCallback, useEffect, useState } from 'react';
import { call, onIpcError, toIpcError, type SpendLimitExceeded, type SpendLimitStatus } from '@kyro/shared';
import { fmtFiat } from '../lib/format';
import { fmtTimeLeft, overrideStep, readExceeded, WAIT_HOUR } from '../lib/spendLimit';
import { useApp } from '../state/app';
import { useT } from '../i18n';
import { PasswordField } from './kit';
import { Dialog } from './ui/dialog';
import { Button, Notice, Spinner } from './ui/primitives';

const REFRESH_MS = 30_000;

/** The limit's state, refreshed while `active`. */
export function useSpendLimit(active: boolean) {
  const [status, setStatus] = useState<SpendLimitStatus | null>(null);
  const reload = useCallback(() => {
    call('spend_limit_status')
      .then(setStatus)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!active) return;
    reload();
    const id = setInterval(reload, REFRESH_MS);
    return () => clearInterval(id);
  }, [active, reload]);
  return { status, setStatus };
}

export const waitLabel = (secs: number) => (secs === WAIT_HOUR ? '1 h' : '24 h');

export function OverrideSteps({ status, onChange }: { status: SpendLimitStatus; onChange: (s: SpendLimitStatus) => void }) {
  const { t } = useT();
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (step: () => Promise<SpendLimitStatus>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await step());
      setPassword('');
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') setWrong((n) => n + 1);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = (
    <Button disabled={busy} onClick={() => void run(() => call('spend_limit_cancel', { what: 'override' }))}>
      {t('limit.cancelRequest')}
    </Button>
  );
  const left = fmtTimeLeft(status.override?.secsLeft ?? 0);
  const step = overrideStep(status);
  const confirm = () => void run(() => call('spend_limit_override_confirm', { password }));
  return (
    <div className="flex flex-col gap-2.5">
      {step === 'request' && (
        <>
          <p className="m-0 text-[13px] text-text2">{t('limit.overrideRequestHint', { wait: waitLabel(status.config?.waitSecs ?? 0) })}</p>
          <div className="flex justify-end">
            <Button variant="primary" disabled={busy} onClick={() => void run(() => call('spend_limit_override_request'))}>
              {busy && <Spinner />} {t('limit.overrideRequest')}
            </Button>
          </div>
        </>
      )}
      {step === 'waiting' && (
        <>
          <p className="m-0 text-[13px] text-text2">{t('limit.overrideWaiting', { time: left })}</p>
          <div className="flex justify-end">{cancel}</div>
        </>
      )}
      {step === 'confirm' && (
        <>
          <p className="m-0 text-[13px] text-text2">{t('limit.overrideReady')}</p>
          <PasswordField id="limit-override-pw" value={password} onChange={setPassword} wrong={wrong} onEnter={confirm} />
          <div className="flex justify-end gap-2">
            {cancel}
            <Button variant="primary" disabled={busy || !password} onClick={confirm}>
              {busy && <Spinner />} {t('limit.overrideConfirm')}
            </Button>
          </div>
        </>
      )}
      {step === 'open' && (
        <>
          <Notice tone="success">{t('limit.overrideOpen', { time: left })}</Notice>
          <div className="flex justify-end">{cancel}</div>
        </>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 text-[14px]">
      <span className="text-mute">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function SpendLimitGate() {
  const { settings, phase } = useApp();
  const { t } = useT();
  const [over, setOver] = useState<SpendLimitExceeded | null>(null);
  const { status, setStatus } = useSpendLimit(over !== null);
  useEffect(
    () =>
      onIpcError((_, e) => {
        if (e.code === 'SPEND_LIMIT') setOver(readExceeded(e.data, settings.currency));
      }),
    [settings.currency],
  );
  // The figures are the wallet's: they do not stay on the lock screen.
  useEffect(() => {
    if (phase !== 'ready') setOver(null);
  }, [phase]);
  if (!over) return null;
  const cur = over.currency;
  return (
    <Dialog open onOpenChange={(v) => !v && setOver(null)} title={t('limit.overTitle')}>
      <p className="m-0 text-[13.5px] leading-[1.55] text-text2">{t('limit.overBody')}</p>
      <div className="flex flex-col gap-1.5 rounded-box border border-line bg-raised/60 px-4 py-3">
        <Row label={t('limit.overSpent')} value={fmtFiat(over.spent, cur)} />
        <Row label={t('limit.overLimit')} value={fmtFiat(over.limit, cur)} />
        <Row label={t('limit.overThis')} value={over.amount === null ? t('limit.overUnknown') : fmtFiat(over.amount, cur)} />
      </div>
      {over.amount === null && <Notice tone="warn">{t('limit.overUnknownBody')}</Notice>}
      {status ? <OverrideSteps status={status} onChange={setStatus} /> : <Spinner />}
      <div className="flex justify-end">
        <Button onClick={() => setOver(null)}>{t('common.close')}</Button>
      </div>
    </Dialog>
  );
}

