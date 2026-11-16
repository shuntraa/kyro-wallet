// SPDX-License-Identifier: GPL-3.0-or-later
// Unlock screen: the Kyro object in ice light, one password field, the frosted button.
import { useState } from 'react';
import { call, toIpcError } from '@kyro/shared';
import { useApp } from '../state/app';
import { PasswordField } from '../components/kit';
import { Notice, Spinner } from '../components/ui/primitives';
import { DISPLAY, Frost, IceDot, IceLight, KyroObject } from '../components/kyro';
import { TitleBar } from '../shell/TitleBar';
import { demoPasswordHint } from './demoHint';
import { useT } from '../i18n';
import { idx } from '../components/motion';

export function Unlock() {
  const { enterVault, demo, wallets, walletName, walletLabel, switchWallet } = useApp();
  const { t } = useT();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [wrong, setWrong] = useState(0);
  const [others, setOthers] = useState(false);
  const several = (wallets?.wallets.length ?? 1) > 1;

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
      // Wrong password: a calm hint under the field (PasswordField), not an error box.
      if (err.code === 'WRONG_PASSWORD') setWrong((n) => n + 1);
      else setError({ code: err.code, message: err.message });
      setBusy(false);
    }
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#05070a] text-text">
      <IceLight x="50%" y="30%" size={900} strength={0.8} id="unlock" />
      <div className="relative z-20">
        <TitleBar bordered={false} />
      </div>
      <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center overflow-y-auto pt-[min(52px,6vh)] pb-8 scroll-thin">
        <div className="rise" style={idx(0)}>
          <KyroObject size={200} />
        </div>
        <h1 className="rise m-0 mt-12 text-[34px] leading-none font-normal" style={{ ...DISPLAY, fontWeight: 600, ...idx(1) }}>
          Kyro
        </h1>
        <p className="rise m-0 mt-4 flex items-center gap-2 text-[13px] text-mute" style={idx(2)}>
          <IceDot size={6} /> {several ? t('wallets.unlockIntro', { name: walletName }) : t('welcome.lockedStatus')}
        </p>

        <form
          className="rise mt-10 flex w-[380px] max-w-[calc(100vw-48px)] flex-col gap-3"
          style={idx(3)}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <PasswordField id="unlock-pw" value={pw} onChange={setPw} autoFocus wrong={wrong} glass />
          {error && <Notice tone={error.code === 'RATE_LIMITED' ? 'warn' : 'error'}>{error.message}</Notice>}
          {demo && <p className="m-0 text-center text-[12px] text-ice-text2">{demoPasswordHint()}</p>}
          <Frost type="submit" className="h-[52px] rounded-[16px] text-[15px]" disabled={!pw || busy}>
            {busy && <Spinner />} {t('welcome.unlock')}
          </Frost>
          {several && (
            <div className="mt-2 flex flex-col items-center gap-2 text-[12.5px]">
              <button type="button" onClick={() => setOthers((o) => !o)} aria-expanded={others} className="text-faint transition-colors hover:text-text2">
                {t('wallets.openOther').replace(/\s*:\s*$/, '')}
              </button>
              {others && (
                <div className="fade-in flex flex-wrap justify-center gap-2">
                  {wallets?.wallets
                    .filter((w) => w.id !== wallets.active)
                    .map((w) => (
                      <button key={w.id} type="button" onClick={() => void switchWallet(w.id)} className="rounded-full bg-white/[.05] px-3 py-1.5 font-semibold text-text2 ring-1 ring-white/[.08] hover:bg-white/[.09] hover:text-text">
                        {walletLabel(w.id)}
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
        </form>
      </main>
    </div>
  );
}
