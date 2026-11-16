// SPDX-License-Identifier: GPL-3.0-or-later
// Onboarding: create a vault (phrase shown once in a native window, 3-word check by Rust) or import
// a BIP39 phrase (wordlist autocomplete). Same look as the unlock screen: the Kyro object in ice
// light, the frosted button, glass.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { call, isDemoMode, toIpcError, type XmrRestoreFrom } from '@kyro/shared';
import { outgoingHosts } from '@kyro/chains';
import { useApp } from '../state/app';
import { setBackupState } from '../lib/storage';
import { cn } from '../lib/cn';
import { PasswordField } from '../components/kit';
import { Input, Notice, Spinner } from '../components/ui/primitives';
import { Dialog } from '../components/ui/dialog';
import { HwSetup } from '../components/hw';
import { WatchAddForm } from '../components/WatchOnly';
import { IconCheck, IconChevronRight, IconUsbKey } from '../components/icons';
import { DISPLAY, Frost, GLASS_ROW, IceDot, KyroObject, NoteRow, NoteSide } from '../components/kyro';
import { demoPasswordHint } from './demoHint';
import { NetworkSwitchDialog, useNetworkInfo } from '../components/NetworkSwitch';
import { idx } from '../components/motion';
import { t, useT } from '../i18n';
import { GlassBig, OnboardingFrame, SquareChoice, StepHead } from './onboardingParts';

export { OnboardingFrame } from './onboardingParts';

type Mode = 'home' | 'create' | 'import' | 'hw' | 'watch';
const MODES: Mode[] = ['home', 'create', 'import', 'hw', 'watch'];

/** Demo only (browser review, never the desktop app): `?welcome=import` opens that flow. */
function demoMode(): Mode {
  if (!isDemoMode() || typeof window === 'undefined') return 'home';
  const m = new URLSearchParams(window.location.search).get('welcome');
  return MODES.find((x) => x === m) ?? 'home';
}

export function Welcome() {
  const [mode, setMode] = useState<Mode>(demoMode);
  const [info, setInfo] = useState<null | 'threat' | 'code' | 'network'>(null);
  const { network, enterVault, status, cancelAddWallet } = useApp();
  const adding = status?.creating ?? null;
  const netInfo = useNetworkInfo();
  const [switchTo, setSwitchTo] = useState<'mainnet' | 'testnet' | null>(null);
  const { t } = useT();

  if (mode === 'create') return <CreateFlow onCancel={() => setMode('home')} />;
  if (mode === 'import') return <ImportFlow onCancel={() => setMode('home')} />;
  if (mode === 'hw') {
    return (
      <OnboardingFrame onBack={() => setMode('home')}>
        <div className="mt-12 flex w-[600px] max-w-full flex-col gap-8">
          <StepHead title={t('welcome.hwTitle')}>{t('welcome.hwIntro')}</StepHead>
          <div className={cn('rounded-[20px] px-6 py-5', GLASS_ROW)}>
            <HwSetup onCancel={() => setMode('home')} onDone={() => void enterVault()} />
          </div>
        </div>
      </OnboardingFrame>
    );
  }

  if (mode === 'watch') {
    return (
      <OnboardingFrame onBack={() => setMode('home')}>
        <div className="mt-12 flex w-[600px] max-w-full flex-col gap-8">
          <StepHead title={t('watch.add')}>{t('watch.intro')}</StepHead>
          <div className={cn('rounded-[20px] px-6 py-5', GLASS_ROW)}>
            <WatchAddForm onAdded={() => enterVault()} />
          </div>
        </div>
      </OnboardingFrame>
    );
  }

  const links: Array<[string, () => void]> = [
    [t('welcome.threatModel'), () => setInfo('threat')],
    [t('welcome.sourceCode'), () => setInfo('code')],
    [t('welcome.networkRequests'), () => setInfo('network')],
  ];
  if (netInfo.data && !adding) links.push([network === 'testnet' ? t('welcome.switchToMainnet') : t('welcome.switchToTestnet'), () => setSwitchTo(network === 'testnet' ? 'mainnet' : 'testnet')]);

  return (
    <OnboardingFrame home>
      <div className="rise" style={idx(0)}>
        <KyroObject size={190} />
      </div>
      <h1 className="rise m-0 mt-12 text-[34px] leading-none" style={{ ...DISPLAY, fontWeight: 600, ...idx(1) }}>
        Kyro
      </h1>
      <p className="rise m-0 mt-4 max-w-[520px] text-center text-[14px] leading-[1.5] text-mute" style={idx(2)}>
        {adding ? t('wallets.addTitle', { name: adding }) : t('welcome.tagline')}
      </p>
      {network === 'testnet' && !adding && (
        <p className="m-0 mt-2 flex items-center gap-2 text-[12.5px] text-warn">
          <IceDot size={5} className="bg-warn shadow-none" /> {t('welcome.onTestnet')}
        </p>
      )}

      <div className="rise mt-10 flex w-[380px] max-w-full flex-col gap-3" style={idx(3)}>
        <Frost className="h-[52px] rounded-[16px] text-[15px]" onClick={() => setMode('create')}>
          {t('welcome.createWallet')}
        </Frost>
        <GlassBig onClick={() => setMode('import')}>{t('welcome.havePhrase')}</GlassBig>
        {!adding && (
          <GlassBig onClick={() => setMode('hw')}>
            <IconUsbKey size={17} className="text-ice" /> {t('welcome.choiceHw')}
          </GlassBig>
        )}
        {adding ? (
          <button type="button" onClick={() => void cancelAddWallet()} className="mt-2 text-center text-[12.5px] text-faint transition-colors hover:text-text2">
            {t('wallets.addCancel')}
          </button>
        ) : (
          <button type="button" onClick={() => setMode('watch')} className="mt-2 text-center text-[12.5px] text-faint transition-colors hover:text-text2">
            {t('welcome.watchLink')}
          </button>
        )}
      </div>

      <nav aria-label={t('welcome.aboutLinks')} className="rise mt-auto flex flex-wrap justify-center gap-x-5 gap-y-1 pt-8 text-[11.5px] text-faint/80" style={idx(4)}>
        {links.map(([label, onClick]) => (
          <button key={label} type="button" onClick={onClick} className="transition-colors hover:text-text2">
            {label}
          </button>
        ))}
      </nav>

      {netInfo.data && <NetworkSwitchDialog info={netInfo.data} target={switchTo} hasVault={false} onClose={() => setSwitchTo(null)} />}
      <Dialog open={info === 'threat'} onOpenChange={() => setInfo(null)} title={t('welcome.threatModel')}>
        <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-[13px] leading-[1.55] text-text2">
          <li>{t('welcome.threat1')}</li>
          <li>{t('welcome.threat2')}</li>
          <li>{t('welcome.threat3')}</li>
          <li>{t('welcome.threat4')}</li>
        </ul>
      </Dialog>
      <Dialog open={info === 'code'} onOpenChange={() => setInfo(null)} title={t('welcome.sourceCode')}>
        <p className="m-0 text-[13px] leading-[1.55] text-text2">{t('welcome.sourceText')}</p>
      </Dialog>
      <Dialog open={info === 'network'} onOpenChange={() => setInfo(null)} title={t('welcome.networkRequests')} description={t('welcome.networkDesc')}>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {outgoingHosts(network).map((h) => (
            <li key={h.host + h.purpose} className="flex flex-col border-t border-line py-2 first:border-t-0">
              <span className="font-mono text-[12px]">{h.host}</span>
              <span className="text-[12px] text-mute">{h.purpose}</span>
            </li>
          ))}
        </ul>
      </Dialog>
    </OnboardingFrame>
  );
}

function passwordIssues(pw: string, confirm: string): string | null {
  if (pw.length < 10) return t('welcome.pwTooShort');
  if (confirm && pw !== confirm) return t('welcome.pwMismatch');
  return null;
}

/** Optional BIP39 passphrase, typed twice. Sent to Rust once, as typed: never trimmed. */
function usePassphrase() {
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const toggle = () => {
    setFirst('');
    setSecond('');
    setOpen((v) => !v);
  };
  const clear = () => {
    setFirst('');
    setSecond('');
  };
  return { open, first, second, setFirst, setSecond, toggle, clear, ready: first === second, args: first && first === second ? { passphrase: first } : {} };
}

function PassphraseFields({ pp }: { pp: ReturnType<typeof usePassphrase> }) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-3">
      <button type="button" aria-expanded={pp.open} onClick={pp.toggle} className="press inline-flex items-center gap-1 self-center text-[12.5px] text-faint hover:text-text2">
        <IconChevronRight size={13} className={cn('transition-transform', pp.open && 'rotate-90')} />
        {t('welcome.advanced')}
      </button>
      {pp.open && (
        <>
          <p className="m-0 text-[12px] leading-[1.5] text-mute">{t('welcome.passphraseHelp')}</p>
          <PasswordField id="pp-new" glass label={t('welcome.passphrase')} placeholder={t('welcome.passphrase')} value={pp.first} onChange={pp.setFirst} autoComplete="off" />
          <PasswordField id="pp-confirm" glass label={t('welcome.passphraseConfirm')} placeholder={t('welcome.passphraseConfirm')} value={pp.second} onChange={pp.setSecond} autoComplete="off" invalid={!!pp.second && !pp.ready} />
          {pp.second && !pp.ready && <p className="m-0 text-[12px] text-down">{t('welcome.passphraseMismatch')}</p>}
          <Notice tone="warn">{t('welcome.passphraseWarn')}</Notice>
        </>
      )}
    </div>
  );
}

function PasswordStep({ busy, error, onSubmit, cta, extra, pp }: { busy: boolean; error: string | null; onSubmit: (pw: string) => void; cta: string; extra?: ReactNode; pp: ReturnType<typeof usePassphrase> }) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const issue = passwordIssues(pw, confirm);
  const { demo } = useApp();
  const { t } = useT();
  const ok = !issue && confirm === pw && pw.length > 0 && pp.ready;
  return (
    <NoteRow
      w={380}
      className="mt-9"
      left={
        <NoteSide side="L" title={t('welcome.notePwTitle')}>
          {t('welcome.pwHelp')}
        </NoteSide>
      }
    >
      <div className="flex flex-col gap-3">
        {extra}
        <PasswordField id="pw-new" glass label={t('shell.vaultPassword')} placeholder={t('shell.vaultPassword')} value={pw} onChange={setPw} autoFocus autoComplete="new-password" />
        <PasswordField id="pw-confirm" glass label={t('welcome.confirmPassword')} placeholder={t('welcome.confirmPassword')} value={confirm} onChange={setConfirm} autoComplete="new-password" invalid={!!confirm && confirm !== pw} onEnter={() => ok && onSubmit(pw)} />
        <p className={cn('m-0 text-center text-[12px] leading-[1.5]', issue && pw ? 'text-mute' : 'text-faint')}>{issue ?? <span className="xl:hidden">{t('welcome.pwHelp')}</span>}</p>
        {demo && <p className="m-0 text-center text-[12px] text-ice-text2">{demoPasswordHint()}</p>}
        {error && <Notice tone="error">{error}</Notice>}
        <Frost className="mt-1 h-[52px] rounded-[16px] text-[15px]" disabled={!ok || busy} onClick={() => onSubmit(pw)}>
          {busy && <Spinner />} {cta}
        </Frost>
        <PassphraseFields pp={pp} />
      </div>
    </NoteRow>
  );
}

function useCaptureProtection(active: boolean) {
  const { settings } = useApp();
  const restore = useRef(settings.captureProtection);
  restore.current = settings.captureProtection;
  useEffect(() => {
    if (!active) return;
    void call('set_capture_protection', { enabled: true }).catch(() => undefined);
    return () => {
      void call('set_capture_protection', { enabled: restore.current }).catch(() => undefined);
    };
  }, [active]);
}

/** Ice-square checkbox. */
function Check({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className={cn('flex cursor-pointer items-center gap-3 text-[13.5px]', disabled && 'cursor-not-allowed opacity-50')}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span aria-hidden="true" className={cn('grid size-[18px] shrink-0 place-items-center rounded-[5px] ring-1 transition-colors peer-focus-visible:outline peer-focus-visible:outline-[1.5px] peer-focus-visible:outline-ice', checked ? 'bg-ice/80 text-[#06121f] ring-ice/60 shadow-[0_0_10px_#7cc4ff66]' : 'bg-white/[.05] ring-white/[.12]')}>
        {checked && <IconCheck size={12} sw={2.6} />}
      </span>
      <span className="text-text2">{children}</span>
    </label>
  );
}

function CreateFlow({ onCancel }: { onCancel: () => void }) {
  const { enterVault } = useApp();
  const [step, setStep] = useState<'password' | 'phrase' | 'verify'>('password');
  const [count, setCount] = useState<12 | 24>(24);
  const [wordCount, setWordCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState(false);
  const [written, setWritten] = useState(false);
  const [checks, setChecks] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [giveUp, setGiveUp] = useState(false);
  const { t, tp } = useT();
  const pp = usePassphrase();
  const steps = [t('welcome.stepPassword'), t('welcome.stepPhrase'), t('welcome.stepVerify')];

  const create = async (pw: string) => {
    setBusy(true);
    setError(null);
    try {
      // Rust creates the vault and keeps the phrase: it is never sent to this interface.
      const res = await call('vault_create', { password: pw, words: count, ...pp.args });
      pp.clear();
      setWordCount(res.wordCount);
      setStep('phrase');
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const show = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await call('vault_backup_show');
      setChecks([...res.checks]);
      setSeen(true);
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const goVerify = () => {
    setAnswers(['', '', '']);
    setVerifyError(null);
    setStep('verify');
  };

  const verify = async () => {
    setBusy(true);
    try {
      const res = await call('vault_backup_verify', { answers: answers.map((a) => a.trim().toLowerCase()) });
      if (res.ok) {
        setBackupState('confirmed');
        await enterVault();
        return;
      }
      if (res.attemptsLeft === 0) {
        setGiveUp(true);
        setVerifyError(t('welcome.tooManyTries'));
      } else {
        setVerifyError(tp('welcome.wordsMismatch', res.attemptsLeft));
      }
    } catch (e) {
      setVerifyError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const continueUnverified = async () => {
    setBackupState('unknown');
    await enterVault();
  };

  if (step === 'password') {
    return (
      <OnboardingFrame onBack={onCancel}>
        <StepHead steps={steps} at={0} title={t('welcome.choosePassword')}>
          {t('welcome.choosePasswordIntro')}
        </StepHead>
        <PasswordStep
          busy={busy}
          error={error}
          onSubmit={create}
          cta={t('welcome.createVault')}
          pp={pp}
          extra={
            <div className="mb-1 flex items-center justify-between gap-4">
              <span className="text-[13px] text-text2">{t('welcome.phraseLength')}</span>
              <SquareChoice label={t('welcome.wordCount')} value={count} onChange={(v) => setCount(v)} items={[{ id: 24, label: t('welcome.words24') }, { id: 12, label: t('welcome.words12') }]} />
            </div>
          }
        />
      </OnboardingFrame>
    );
  }

  if (step === 'phrase') {
    return (
      <OnboardingFrame>
        <StepHead steps={steps} at={1} title={t('welcome.writeTitle')}>
          {t('welcome.writeIntro', { count: wordCount })}
        </StepHead>
        <NoteRow
          w={380}
          className="mt-10"
          left={
            <NoteSide side="L" title={t('welcome.notePhotoTitle')}>
              {t('welcome.notePhoto')}
            </NoteSide>
          }
          right={
            <NoteSide side="R" title={t('welcome.noteWindowTitle')}>
              {t('welcome.noteWindow')}
            </NoteSide>
          }
        >
          <div className="flex flex-col gap-4">
            <p className="m-0 flex items-center justify-center gap-2 text-[12.5px] text-mute">
              <IceDot size={5} /> {t('welcome.writeWarn')}
            </p>
            {seen ? (
              <GlassBig disabled={busy} onClick={() => void show()}>
                {busy && <Spinner />} {busy ? t('common.systemWindowOpen') : t('welcome.showAgain')}
              </GlassBig>
            ) : (
              <Frost className="h-[52px] rounded-[16px] text-[15px]" disabled={busy} onClick={() => void show()}>
                {busy && <Spinner />} {busy ? t('common.systemWindowOpen') : t('welcome.showPhrase')}
              </Frost>
            )}
            {error && <Notice tone="error">{error}</Notice>}
            <div className={cn('rounded-[16px] px-4 py-3.5', GLASS_ROW)}>
              <Check checked={written} disabled={!seen} onChange={setWritten}>
                {t('welcome.wroteWords', { count: wordCount })}
              </Check>
            </div>
            {seen && (
              <Frost className="fade-in h-[52px] rounded-[16px] text-[15px]" disabled={!written || busy} onClick={goVerify}>
                {t('welcome.verifyBackup')}
              </Frost>
            )}
          </div>
        </NoteRow>
      </OnboardingFrame>
    );
  }

  return (
    <OnboardingFrame onBack={() => setStep('phrase')}>
      <StepHead steps={steps} at={2} title={t('welcome.verifyTitle')}>
        {t('welcome.verifyIntro')}
      </StepHead>
      <div className="mt-9 flex w-[380px] max-w-full flex-col gap-2.5">
        {checks.map((index, i) => (
          <WordInput key={index} index={index} value={answers[i] ?? ''} onChange={(v) => setAnswers((a) => a.map((x, j) => (j === i ? v : x)))} autoFocus={i === 0} onEnter={() => void verify()} />
        ))}
        {verifyError && <Notice tone="error">{verifyError}</Notice>}
        <div className="mt-3 flex flex-col gap-3">
          {giveUp ? (
            <Frost className="h-[52px] rounded-[16px] text-[15px]" onClick={() => void continueUnverified()}>
              {t('welcome.continueUnverified')}
            </Frost>
          ) : (
            <>
              <Frost className="h-[52px] rounded-[16px] text-[15px]" disabled={busy || answers.some((a) => !a.trim())} onClick={() => void verify()}>
                {busy && <Spinner />} {t('welcome.finish')}
              </Frost>
              <GlassBig
                onClick={() => {
                  setSeen(false);
                  setWritten(false);
                  setStep('phrase');
                }}
              >
                {t('welcome.reviewPhrase')}
              </GlassBig>
            </>
          )}
        </div>
      </div>
    </OnboardingFrame>
  );
}

/** Word field with BIP39 autocomplete (English wordlist), glass like the mock's word tiles. */
function WordInput({ index, value, onChange, autoFocus, onEnter, onPasteMany, compact }: { index: number; value: string; onChange: (v: string) => void; autoFocus?: boolean; onEnter?: () => void; onPasteMany?: (words: string[]) => void; compact?: boolean }) {
  const [focused, setFocused] = useState(false);
  const { t } = useT();
  const v = value.trim().toLowerCase();
  const suggestions = useMemo(() => (v.length >= 1 ? wordlist.filter((w) => w.startsWith(v)).slice(0, 4) : []), [v]);
  const known = v.length > 0 && wordlist.includes(v);
  const invalid = v.length > 0 && !known && suggestions.length === 0;
  const show = focused && suggestions.length > 0 && !(suggestions.length === 1 && suggestions[0] === v);
  return (
    <div className="relative">
      <label className={cn('flex items-center gap-3 rounded-[12px] px-4 transition-shadow focus-within:ring-ice-line', GLASS_ROW, compact ? 'h-11' : 'h-[52px]', invalid && 'ring-down/60')}>
        <span className="figure w-5 text-right text-[11.5px] text-faint">{index + 1}</span>
        <span className="sr-only">{t('welcome.wordN', { n: index + 1 })}</span>
        <input
          value={value}
          aria-label={t('welcome.wordN', { n: index + 1 })}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onChange={(e) => onChange(e.target.value.replace(/\s/g, '').toLowerCase())}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            const parts = text.trim().toLowerCase().split(/\s+/);
            if (parts.length > 1 && onPasteMany) {
              e.preventDefault();
              onPasteMany(parts);
            }
          }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === 'Tab') && show && suggestions[0]) {
              if (e.key === 'Enter') e.preventDefault();
              onChange(suggestions[0]);
            } else if (e.key === 'Enter') onEnter?.();
          }}
          className="min-w-0 flex-1 bg-transparent font-mono text-[14px] text-text"
        />
        {known && <span aria-hidden="true" className="size-[5px] bg-ice shadow-[0_0_8px_#7cc4ff]" />}
      </label>
      {show && (
        <div className="pop-in absolute top-full right-0 left-0 z-20 mt-1 flex gap-1 rounded-[12px] bg-[#0d1219]/95 p-1 ring-1 ring-white/[.09] backdrop-blur-xl">
          {suggestions.map((s) => (
            <button key={s} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onChange(s)} className="rounded-[8px] px-2 py-1 font-mono text-[12px] text-text2 hover:bg-white/[.08]">
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ImportFlow({ onCancel }: { onCancel: () => void }) {
  const { enterVault } = useApp();
  const [count, setCount] = useState<12 | 24>(12);
  const [words, setWords] = useState<string[]>(() => Array(12).fill(''));
  const [step, setStep] = useState<'phrase' | 'password'>('phrase');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [xmrLedger, setXmrLedger] = useState(false);
  const [xmrMode, setXmrMode] = useState<'date' | 'genesis'>('date');
  const [xmrDate, setXmrDate] = useState('');
  const { t } = useT();
  const pp = usePassphrase();
  const steps = [t('welcome.stepPhrase'), t('welcome.stepPassword')];
  const xmrRestore = ((): XmrRestoreFrom | null => {
    if (!xmrLedger) return { kind: 'kyro' };
    if (xmrMode === 'genesis') return { kind: 'genesis' };
    const ms = Date.parse(xmrDate);
    return Number.isFinite(ms) ? { kind: 'date', date: Math.floor(ms / 1000) } : null;
  })();

  useCaptureProtection(true);
  // No unmount cleanup clearing `words`: StrictMode's mount/unmount/remount ran it right away and
  // left the grid empty.

  const resize = (n: 12 | 24) => {
    setCount(n);
    setWords((w) => [...w.slice(0, n), ...Array(Math.max(0, n - w.length)).fill('')]);
  };
  const phrase = words.map((w) => w.trim().toLowerCase()).join(' ');
  const filled = words.every((w) => w.trim());
  const valid = filled && validateMnemonic(phrase, wordlist);
  const unknown = words.filter((w) => w && !wordlist.includes(w.trim().toLowerCase())).length;

  const pasteMany = (start: number, parts: string[]) => {
    if (parts.length === 12 || parts.length === 24) {
      resize(parts.length as 12 | 24);
      setWords(parts);
      return;
    }
    setWords((w) => w.map((x, i) => (i >= start && i - start < parts.length ? parts[i - start] ?? x : x)));
  };

  const submit = async (pw: string) => {
    setBusy(true);
    setError(null);
    try {
      await call('vault_import', { password: pw, phrase, xmrRestore: xmrRestore ?? { kind: 'kyro' }, ...pp.args });
      setWords([]);
      pp.clear();
      setBackupState('imported');
      await enterVault();
    } catch (e) {
      setError(toIpcError(e).message);
      setBusy(false);
    }
  };

  if (step === 'password') {
    return (
      <OnboardingFrame onBack={() => setStep('phrase')}>
        <StepHead steps={steps} at={1} title={t('welcome.protectTitle')}>
          {t('welcome.protectIntro')}
        </StepHead>
        <PasswordStep busy={busy} error={error} onSubmit={(pw) => void submit(pw)} cta={t('welcome.import')} pp={pp} />
      </OnboardingFrame>
    );
  }

  return (
    <OnboardingFrame onBack={onCancel}>
      <StepHead steps={steps} at={0} title={t('welcome.importTitle')}>
        {t('welcome.importIntro')}
      </StepHead>
      <div className="mt-6">
        <SquareChoice label={t('welcome.wordCount')} value={count} onChange={resize} items={[{ id: 12, label: t('welcome.words12') }, { id: 24, label: t('welcome.words24') }]} />
      </div>
      <NoteRow
        w={count === 24 ? 760 : 600}
        className="mt-6 w-full"
        left={
          <NoteSide side="L" title={t('welcome.notePhotoTitle')}>
            {t('welcome.captureBlocked')}
          </NoteSide>
        }
        right={
          <NoteSide side="R" title={t('welcome.noteOfflineTitle')}>
            {t('welcome.wordsStayHere')}
          </NoteSide>
        }
      >
        <div className={cn('grid gap-2.5', count === 24 ? 'grid-cols-4' : 'grid-cols-3')}>
          {words.map((w, i) => (
            <WordInput key={`${count}-${i}`} compact index={i} value={w} autoFocus={i === 0} onChange={(v) => setWords((ws) => ws.map((x, j) => (j === i ? v : x)))} onPasteMany={(parts) => pasteMany(i, parts)} />
          ))}
        </div>
      </NoteRow>
      <div className="mt-4 text-center text-[13px]" role="status">
        {unknown > 0 ? (
          <span className="text-down">{t('welcome.unknownWords', { count: unknown })}</span>
        ) : filled && !valid ? (
          <span className="text-down">{t('welcome.badChecksum')}</span>
        ) : valid ? (
          <span className="text-up">{t('welcome.validPhrase')}</span>
        ) : (
          <span className="text-faint xl:hidden">{t('welcome.wordsStayHere')}</span>
        )}
      </div>
      <div className={cn('mt-5 flex w-[600px] max-w-full flex-col gap-2.5 rounded-[16px] px-5 py-4 text-[13px]', GLASS_ROW)}>
        <span className="text-mute">{t('welcome.xmrDefault')}</span>
        <Check checked={xmrLedger} onChange={setXmrLedger}>
          {t('welcome.xmrLedger')}
        </Check>
        {xmrLedger && (
          <>
            <div className="self-start">
              <SquareChoice label={t('welcome.xmrLedger')} value={xmrMode} onChange={setXmrMode} items={[{ id: 'date', label: t('welcome.xmrFromDate') }, { id: 'genesis', label: t('welcome.xmrFromGenesis') }]} />
            </div>
            {xmrMode === 'date' ? (
              <label className="flex flex-col gap-1">
                <span className="text-mute">{t('welcome.xmrDateLabel')}</span>
                <Input type="date" value={xmrDate} onChange={(e) => setXmrDate(e.target.value)} min="2014-04-18" max={new Date().toISOString().slice(0, 10)} className="w-[200px]" />
              </label>
            ) : (
              <Notice tone="warn">{t('welcome.xmrGenesisWarn')}</Notice>
            )}
          </>
        )}
      </div>
      <Frost className="mt-6 h-[52px] w-[380px] max-w-full rounded-[16px] text-[15px]" disabled={!valid || xmrRestore === null} onClick={() => setStep('password')}>
        {t('common.continue')}
      </Frost>
    </OnboardingFrame>
  );
}
