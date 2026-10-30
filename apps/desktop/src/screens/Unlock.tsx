// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { call, toIpcError } from '@kyro/shared';
import { useApp } from '../state/app';
import { PasswordField } from '../components/kit';
import { Button, Notice, Spinner } from '../components/ui/primitives';
import { IconLock } from '../components/icons';
import { OnboardingFrame } from './Welcome';
import { DEMO_PASSWORD_HINT } from './demoHint';
import { idx } from '../components/motion';

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
      <div className="flex max-w-[440px] flex-col gap-8">
        <div className="flex flex-col gap-4">
          <span className="rise eyebrow flex items-center gap-2 text-mute">
            <IconLock size={13} className="text-ice" />
            Kyro
          </span>
          <h1 className="rise m-0 text-[52px] leading-[1] font-[560] tracking-[-0.05em]" style={idx(1)}>
            Coffre verrouillé<span className="text-ice">.</span>
          </h1>
          <p className="rise m-0 text-[15px] leading-[1.6] text-mute" style={idx(2)}>Saisis ton mot de passe pour déchiffrer le coffre sur cet appareil.</p>
        </div>
        <form
          className="rise flex flex-col gap-4"
          style={idx(3)}
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
        <p className="m-0 border-t border-line pt-4 text-[12px] leading-[1.6] text-faint">Kyro ne peut pas récupérer ton mot de passe. Si tu l’as perdu, seule ta phrase de récupération permet de restaurer tes fonds.</p>
      </div>
    </OnboardingFrame>
  );
}
