// SPDX-License-Identifier: GPL-3.0-or-later
// Settings › Security: the daily spending limit of the wallet in use. Rust keeps it and enforces it
// when a signature is approved (spend_limit.rs); this screen sets it and shows what is waiting.

import { useState } from 'react';
import { call, toIpcError, type SpendLimitConfig, type SpendLimitStatus } from '@kyro/shared';
import { fiatDigits, fmtFiat, sanitizeDecimalInput } from '../../lib/format';
import { changeTiming, fmtTimeLeft, overrideStep, parseLimitAmount, usedShare, WAIT_DAY, WAIT_HOUR } from '../../lib/spendLimit';
import { useApp } from '../../state/app';
import { PasswordField } from '../../components/kit';
import { OverrideSteps, useSpendLimit, waitLabel } from '../../components/SpendLimitGate';
import { Dialog } from '../../components/ui/dialog';
import { Button, Input, Notice, Segmented, Spinner, Switch } from '../../components/ui/primitives';
import { useT } from '../../i18n';

type Form = 'on' | 'edit' | 'off';

function LimitForm({ mode, status, onClose, onDone }: { mode: Form; status: SpendLimitStatus; onClose: () => void; onDone: (s: SpendLimitStatus) => void }) {
  const { settings } = useApp();
  const { t } = useT();
  const current = status.config;
  const currency = settings.currency;
  const [amount, setAmount] = useState(mode === 'edit' && current?.currency === currency ? String(current.amount) : '');
  const [wait, setWait] = useState(current?.waitSecs ?? WAIT_DAY);
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const off = mode === 'off';
  const value = parseLimitAmount(amount);
  const next: SpendLimitConfig | null = off || value === null ? null : { amount: value, currency, waitSecs: wait };
  const ready = !!password && !busy && (off || value !== null);
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await call('spend_limit_set', { enabled: !off, amount: value ?? 0, currency, waitSecs: wait, password }));
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') setWrong((n) => n + 1);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const title = { on: t('limit.formTitleOn'), edit: t('limit.formTitleEdit'), off: t('limit.formTitleOff') }[mode];
  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()} title={title}>
      {!off && (
        <>
          <label className="flex flex-col gap-1.5 text-[13px] text-mute">
            {t('limit.amount', { currency })}
            <Input value={amount} inputMode="decimal" autoFocus onChange={(e) => setAmount(sanitizeDecimalInput(e.target.value, fiatDigits(currency)))} />
          </label>
          <div className="flex items-center justify-between gap-4 text-[13px] text-mute">
            {t('limit.wait')}
            <Segmented
              label={t('limit.wait')}
              value={wait}
              onChange={setWait}
              options={[
                { value: WAIT_HOUR, label: t('limit.wait1h') },
                { value: WAIT_DAY, label: t('limit.wait24h') },
              ]}
            />
          </div>
        </>
      )}
      {(off || value !== null) && (
        <p className="m-0 text-[13px] text-text2">{changeTiming(current, next) === 'now' ? t('limit.appliesNow') : t('limit.appliesLater', { wait: waitLabel(current?.waitSecs ?? WAIT_DAY) })}</p>
      )}
      <PasswordField id="limit-pw" value={password} onChange={setPassword} wrong={wrong} onEnter={() => void submit()} />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={!ready} onClick={() => void submit()}>
          {busy && <Spinner />} {t('limit.save')}
        </Button>
      </div>
    </Dialog>
  );
}

function PendingChange({ status, onChange }: { status: SpendLimitStatus; onChange: (s: SpendLimitStatus) => void }) {
  const { t } = useT();
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = status.change;
  if (!change) return null;
  const run = async (step: () => Promise<SpendLimitStatus>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await step());
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') setWrong((n) => n + 1);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const target = change.target;
  const ready = change.secsLeft === 0;
  const apply = () => void run(() => call('spend_limit_apply', { password }));
  return (
    <div className="flex flex-col gap-2.5 border-t border-line py-4">
      <span className="text-[14px] font-medium">{target ? t('limit.pendingRaise', { amount: fmtFiat(target.amount, target.currency), wait: waitLabel(target.waitSecs) }) : t('limit.pendingOff')}</span>
      <span className="text-[13px] text-mute">{ready ? t('limit.pendingReady') : t('limit.timeLeft', { time: fmtTimeLeft(change.secsLeft) })}</span>
      {ready && <PasswordField id="limit-apply-pw" value={password} onChange={setPassword} wrong={wrong} onEnter={apply} />}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={() => void run(() => call('spend_limit_cancel', { what: 'change' }))}>
          {t('limit.cancelRequest')}
        </Button>
        {ready && (
          <Button variant="primary" disabled={busy || !password} onClick={apply}>
            {busy && <Spinner />} {t('limit.apply')}
          </Button>
        )}
      </div>
    </div>
  );
}

export function SpendLimitSection() {
  const { t } = useT();
  const { status, setStatus } = useSpendLimit(true);
  const [form, setForm] = useState<Form | null>(null);
  if (!status) return null;
  const config = status.config;
  return (
    <section className="flex flex-col rounded-panel border border-line bg-card px-6 py-1.5">
      <div className="flex items-center justify-between gap-6 py-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[14.5px] font-medium">{t('limit.title')}</span>
          <span className="text-[13px] text-mute">{t('limit.desc')}</span>
        </div>
        <Switch label={t('limit.title')} checked={!!config} onCheckedChange={(v) => setForm(v ? 'on' : 'off')} />
      </div>
      {config && (
        <div className="flex flex-col gap-2.5 border-t border-line py-4">
          <div className="flex items-center justify-between gap-6">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[14px] font-medium tabular-nums">{t('limit.spent', { spent: fmtFiat(status.spent, config.currency), limit: fmtFiat(config.amount, config.currency) })}</span>
              <span className="text-[13px] text-mute">{t('limit.settings', { wait: waitLabel(config.waitSecs) })}</span>
            </div>
            <Button variant="outline" size="md" onClick={() => setForm('edit')}>
              {t('limit.change')}
            </Button>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-control" aria-hidden="true">
            <div className="h-full rounded-full bg-ice" style={{ width: `${usedShare(status.spent, config.amount) * 100}%` }} />
          </div>
        </div>
      )}
      <PendingChange status={status} onChange={setStatus} />
      {config && overrideStep(status) !== 'request' && (
        <div className="border-t border-line py-4">
          <OverrideSteps status={status} onChange={setStatus} />
        </div>
      )}
      <div className="flex flex-col gap-1 border-t border-line py-4 text-[13px] leading-[1.5] text-mute">
        <span className="font-medium text-text2">{t('limit.countsTitle')}</span>
        <span>{t('limit.counts')}</span>
        <span>{t('limit.notCounted')}</span>
        <span>{t('limit.perWallet')}</span>
        <span className="text-text2">{t('limit.honest')}</span>
      </div>
      {form && (
        <LimitForm
          mode={form}
          status={status}
          onClose={() => setForm(null)}
          onDone={(s) => {
            setStatus(s);
            setForm(null);
          }}
        />
      )}
    </section>
  );
}
