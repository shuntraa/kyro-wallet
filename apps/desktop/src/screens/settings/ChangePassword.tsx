// SPDX-License-Identifier: GPL-3.0-or-later
// Réglages › Sécurité: new password for the wallet in use. Rust re-encrypts its vault, checks the
// new file, swaps it in, then locks: the next unlock proves the new password.

import { useState } from 'react';
import { call, toIpcError } from '@kyro/shared';
import { useApp } from '../../state/app';
import { PasswordField } from '../../components/kit';
import { Dialog } from '../../components/ui/dialog';
import { Button, Notice, Spinner } from '../../components/ui/primitives';
import { useT } from '../../i18n';

const MIN_LENGTH = 10;

export function ChangePassword() {
  const { enterVault, walletName, wallets } = useApp();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [wrong, setWrong] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setCurrent('');
    setNext('');
    setAgain('');
    setError(null);
    setOpen(false);
  };
  const problem = next && next.length < MIN_LENGTH ? t('welcome.pwTooShort') : again && again !== next ? t('wallets.pwMismatch') : next && next === current ? t('wallets.pwSame') : null;
  const ready = !!current && next.length >= MIN_LENGTH && next === again && next !== current && !busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await call('vault_change_password', { current, next });
      close();
      await enterVault();
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') setWrong((n) => n + 1);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="outline" size="md" onClick={() => setOpen(true)}>
        {t('common.password')}
      </Button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : !busy && close())} title={t('wallets.pwTitle')}>
        <p className="m-0 text-[13px] leading-[1.55] text-text2">{(wallets?.wallets.length ?? 1) > 1 ? t('wallets.pwIntroNamed', { name: walletName }) : t('wallets.pwIntro')}</p>
        <PasswordField id="pw-current" label={t('wallets.pwCurrent')} value={current} onChange={setCurrent} autoFocus wrong={wrong} />
        <PasswordField id="pw-next" label={t('wallets.pwNew')} value={next} onChange={setNext} autoComplete="new-password" />
        <PasswordField id="pw-again" label={t('wallets.pwAgain')} value={again} onChange={setAgain} autoComplete="new-password" onEnter={() => void submit()} />
        {problem && <span className="text-[12px] text-down">{problem}</span>}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!ready} onClick={() => void submit()}>
            {busy && <Spinner />} {t('wallets.pwSubmit')}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
