// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { call, toIpcError } from '@kyro/shared';
import { useApp } from '../state/app';
import { PasswordField } from '../components/kit';
import { Button, Notice, Spinner } from '../components/ui/primitives';
import { IconLock } from '../components/icons';
import { OnboardingFrame } from './Welcome';
import { DEMO_PASSWORD_HINT } from './demoHint';

export function Unlock() {
  const { enterVault, demo } = useApp();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const submit = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setError(null);
    try {
      await call('vault_unlock', { password: pw });
      setPw('');
      await enterVault();
    } catch (e) {
      const err = toIpcError(e);
      setError({ code: err.code, message: err.message });
      setBusy(false);
    }
  };

  return (
    <OnboardingFrame status={<span className="flex items-center gap-1.5 text-mute"><span className="size-1.5 rounded-full bg-faint" />Coffre verrouillé · session effacée</span>}>
      <div className="flex max-w-[460px] flex-col gap-7">
        <div className="flex flex-col gap-4">
          <span className="flex size-12 items-center justify-center rounded-[14px] bg-ice/12 text-ice">
            <IconLock size={20} />
          </span>
          <h1 className="m-0 text-[44px] leading-[1.05] font-semibold tracking-[-0.04em]">Coffre verrouillé</h1>
          <p className="m-0 text-[15px] leading-[1.6] text-mute">Saisis ton mot de passe pour déchiffrer le coffre sur cet appareil.</p>
        </div>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <PasswordField id="unlock-pw" value={pw} onChange={setPw} autoFocus invalid={error?.code === 'WRONG_PASSWORD'} />
          {error && <Notice tone={error.code === 'RATE_LIMITED' ? 'warn' : 'error'}>{error.message}</Notice>}
          {demo && <p className="m-0 text-[12px] text-ice-text2">{DEMO_PASSWORD_HINT}</p>}
          <Button type="submit" variant="primary" size="xl" disabled={!pw || busy}>
            {busy && <Spinner />} Déverrouiller
          </Button>
        </form>
        <p className="m-0 text-[12px] leading-[1.6] text-faint">Kyro ne peut pas récupérer ton mot de passe. Si tu l’as perdu, seule ta phrase de récupération permet de restaurer tes fonds.</p>
      </div>
    </OnboardingFrame>
  );
}
