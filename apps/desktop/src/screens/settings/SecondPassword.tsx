// SPDX-License-Identifier: GPL-3.0-or-later
// Réglages › Sécurité: optional second password (docs/IPC.md §2.9d). Same words in every session,
// so nothing here tells which wallet is open. Rust creates the wallet and shows its phrase.

import { useEffect, useState } from 'react';
import { call, toIpcError } from '@kyro/shared';
import { PasswordField } from '../../components/kit';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Button, Notice, Spinner } from '../../components/ui/primitives';
import { IconWarn } from '../../components/icons';
import { purgeStoreScope } from '../../lib/storage';
import { useT } from '../../i18n';

const MIN_LENGTH = 10;

type Step = 'enable' | 'phrase' | 'disable';

export function SecondPassword() {
  const { t } = useT();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [wrong, setWrong] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const refresh = async () => setEnabled((await call('duress_status')).enabled);
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, []);

  const close = () => {
    setCurrent('');
    setNext('');
    setAgain('');
    setError(null);
    setStep(null);
  };
  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await job();
      close();
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') setWrong((n) => n + 1);
      else if (err.code !== 'USER_REJECTED') setError(err.message);
    } finally {
      setBusy(false);
      void refresh().catch(() => undefined);
    }
  };

  const problem = next && next.length < MIN_LENGTH ? t('welcome.pwTooShort') : again && again !== next ? t('wallets.pwMismatch') : next && next === current ? t('wallets.secondSame') : null;
  const ready = !!current && next.length >= MIN_LENGTH && next === again && next !== current && !busy;
  const enable = () => {
    if (ready)
      void run(async () => {
        await call('duress_enable', { current, password: next });
        setDone(true);
      });
  };
  const showPhrase = () => {
    if (current && !busy) void run(() => call('duress_show_phrase', { password: current }));
  };
  const disable = () => {
    if (current && !busy)
      void run(async () => {
        purgeStoreScope(await call('duress_disable', { password: current }));
        setDone(false);
      });
  };

  return (
    <section className="flex flex-col gap-3 rounded-panel border border-line bg-card px-[22px] py-[18px]">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[14px] font-semibold">{t('wallets.secondTitle')}</span>
        {enabled && <Badge tone="up">{t('wallets.secondOn')}</Badge>}
      </div>
      <p className="m-0 text-[13px] leading-[1.55] text-text2">{t('wallets.secondIntro')}</p>
      <p className="m-0 text-[13px] leading-[1.55] text-text2">{t('wallets.secondFund')}</p>
      <p className="m-0 text-[12px] leading-[1.5] text-mute">{t('wallets.secondLimit')}</p>
      {done && enabled && <Notice tone="info">{t('wallets.secondDone')}</Notice>}
      {enabled !== null && (
        <div className="flex justify-end gap-2">
          {enabled ? (
            <>
              <Button size="md" variant="outline" onClick={() => setStep('phrase')}>
                {t('wallets.secondPhrase')}
              </Button>
              <Button size="md" variant="dangerOutline" onClick={() => setStep('disable')}>
                {t('wallets.secondDisable')}
              </Button>
            </>
          ) : (
            <Button size="md" variant="outline" onClick={() => setStep('enable')}>
              {t('wallets.secondEnable')}
            </Button>
          )}
        </div>
      )}
      {step === 'enable' && (
        <Dialog open onOpenChange={(v) => !v && !busy && close()} title={t('wallets.secondEnableTitle')}>
          <p className="m-0 text-[13px] leading-[1.55] text-text2">{t('wallets.secondEnableBody')}</p>
          <PasswordField id="second-current" label={t('wallets.pwCurrent')} value={current} onChange={setCurrent} autoFocus wrong={wrong} />
          <PasswordField id="second-next" label={t('wallets.secondNew')} value={next} onChange={setNext} autoComplete="new-password" />
          <PasswordField id="second-again" label={t('wallets.secondAgain')} value={again} onChange={setAgain} autoComplete="new-password" onEnter={enable} />
          {problem && <span className="text-[12px] text-down">{problem}</span>}
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button onClick={close} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={!ready} onClick={enable}>
              {busy && <Spinner />} {t('wallets.secondEnable')}
            </Button>
          </div>
        </Dialog>
      )}
      {step === 'phrase' && (
        <Dialog open onOpenChange={(v) => !v && !busy && close()} title={t('wallets.secondPhrase')}>
          <p className="m-0 text-[13px] leading-[1.55] text-text2">{t('wallets.secondPhraseBody')}</p>
          <PasswordField id="second-phrase" label={t('wallets.secondNew')} value={current} onChange={setCurrent} autoFocus wrong={wrong} onEnter={showPhrase} />
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button onClick={close} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" disabled={!current || busy} onClick={showPhrase}>
              {busy && <Spinner />} {busy ? t('common.systemWindowOpen') : t('common.show')}
            </Button>
          </div>
        </Dialog>
      )}
      {step === 'disable' && (
        <Dialog open onOpenChange={(v) => !v && !busy && close()} title={t('wallets.secondDisableTitle')}>
          <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
            {t('wallets.secondDisableBody')}
          </Notice>
          <PasswordField id="second-disable" label={t('wallets.pwCurrent')} value={current} onChange={setCurrent} autoFocus wrong={wrong} onEnter={disable} />
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button onClick={close} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" disabled={!current || busy} onClick={disable}>
              {busy && <Spinner />} {busy ? t('common.systemWindowOpen') : t('wallets.secondDisable')}
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
