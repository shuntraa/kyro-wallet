// SPDX-License-Identifier: GPL-3.0-or-later
// Onboarding: create a vault (phrase shown once in a native window, 3-word check by Rust) or import
// a BIP39 phrase (wordlist autocomplete).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { call, toIpcError, type XmrRestoreFrom } from '@kyro/shared';
import { outgoingHosts } from '@kyro/chains';
import { useApp } from '../state/app';
import { setBackupState } from '../lib/storage';
import { cn } from '../lib/cn';
import { TitleBar } from '../shell/TitleBar';
import { StatusFrame } from '../shell/StatusBar';
import { KyroMark, PasswordField } from '../components/kit';
import { Button, Input, Notice, Segmented, Spinner } from '../components/ui/primitives';
import { Dialog } from '../components/ui/dialog';
import { HwSetup } from '../components/hw';
import { IconBack, IconChevronRight, IconImport, IconPlus, IconUsbKey, IconWarn } from '../components/icons';
import { demoPasswordHint } from './demoHint';
import { NetworkSwitchDialog, useNetworkInfo } from '../components/NetworkSwitch';
import { NETWORK_HINT } from '../lib/network';
import { idx } from '../components/motion';
import { t, useT } from '../i18n';
import { rt } from '../i18n/rich';

function BrandPanel() {
  return (
    <section aria-hidden="true" className="flex w-[40%] max-w-[560px] min-w-[360px] shrink-0 flex-col items-center justify-center gap-5 border-r border-rail bg-panel">
      <KyroMark size={88} />
      <span className="text-[22px] font-semibold tracking-[-0.02em]">Kyro</span>
    </section>
  );
}

export function OnboardingFrame({ children, status }: { children: ReactNode; status?: ReactNode }) {
  const { t } = useT();
  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <TitleBar bordered={false} />
      <div className="flex min-h-0 flex-1">
        <BrandPanel />
        <main className="flex min-w-0 flex-1 flex-col justify-center overflow-y-auto px-[min(88px,6.5vw)] py-8 scroll-thin">{children}</main>
      </div>
      <StatusFrame left={status ?? <span className="text-mute">{t('welcome.noVaultHere')}</span>} />
    </div>
  );
}

type Mode = 'home' | 'create' | 'import' | 'hw';

export function Welcome() {
  const [mode, setMode] = useState<Mode>('home');
  const [info, setInfo] = useState<null | 'threat' | 'code' | 'network'>(null);
  const { network, enterVault } = useApp();
  const netInfo = useNetworkInfo();
  const [switchTo, setSwitchTo] = useState<'mainnet' | 'testnet' | null>(null);
  const { t } = useT();

  if (mode === 'create') return <CreateFlow onCancel={() => setMode('home')} />;
  if (mode === 'import') return <ImportFlow onCancel={() => setMode('home')} />;
  if (mode === 'hw') {
    return (
      <OnboardingFrame status={<span className="text-mute">{t('welcome.hwOnlyStatus')}</span>}>
        <div className="flex max-w-[600px] flex-col gap-6">
          <StepHeader step={1} total={1} title={t('welcome.hwTitle')} onBack={() => setMode('home')}>
            {t('welcome.hwIntro')}
          </StepHeader>
          <HwSetup onCancel={() => setMode('home')} onDone={() => void enterVault()} />
        </div>
      </OnboardingFrame>
    );
  }

  return (
    <OnboardingFrame>
      <div className="flex max-w-[560px] flex-col gap-10">
        <div className="flex flex-col gap-3">
          <h1 className="rise m-0 text-[32px] leading-[1.15] font-semibold tracking-[-0.02em]" style={idx(0)}>
            {t('welcome.title')}
          </h1>
          <p className="rise m-0 max-w-[440px] text-[15px] leading-[1.6] text-mute" style={idx(1)}>{t('welcome.subtitle')}</p>
        </div>

        <div className="rise flex max-w-[540px] flex-col border-t border-line" style={idx(2)}>
          <ChoiceCard
            icon={<IconUsbKey size={20} />}
            iconClass="text-ice"
            title={t('welcome.choiceHw')}
            subtitle={t('welcome.choiceHwSub')}
            onClick={() => setMode('hw')}
          />
          <ChoiceCard icon={<IconPlus size={20} />} title={t('welcome.choiceCreate')} subtitle={t('welcome.choiceCreateSub')} onClick={() => setMode('create')} />
          <ChoiceCard icon={<IconImport size={20} />} title={t('welcome.choiceImport')} subtitle={t('welcome.choiceImportSub')} onClick={() => setMode('import')} />
        </div>

        <p className="rise -mt-6 m-0 text-[13px] text-mute" style={idx(3)}>
          {rt(network === 'mainnet' ? 'welcome.vaultOnMainnet' : 'welcome.vaultOnTestnet', { b: (c) => <span className="text-text2">{c}</span> }, { hint: NETWORK_HINT[network] })}{' '}
          {netInfo.data?.canSwitch && (
            <button type="button" className="text-ice underline decoration-ice/40 underline-offset-[4px] hover:decoration-ice" onClick={() => setSwitchTo(network === 'mainnet' ? 'testnet' : 'mainnet')}>
              {t(network === 'mainnet' ? 'welcome.switchToTestnet' : 'welcome.switchToMainnet')}
            </button>
          )}
        </p>

        <div className="rise flex gap-6 text-[13px]" style={idx(4)}>
          {(
            [
              ['threat', t('welcome.threatModel')],
              ['code', t('welcome.sourceCode')],
              ['network', t('welcome.networkRequests')],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" className="text-mute underline decoration-line-3 underline-offset-[5px] transition-colors hover:text-text hover:decoration-ice" onClick={() => setInfo(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

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

function ChoiceCard({ icon, title, subtitle, onClick, disabled, iconClass }: { icon: ReactNode; title: ReactNode; subtitle: string; onClick?: () => void; disabled?: boolean; iconClass?: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn('group relative flex items-center gap-4 border-b border-line py-[18px] pr-2 pl-1 text-left transition-colors duration-150', disabled ? 'opacity-70' : 'hover:bg-raised/40')}
    >
      <span className={cn('flex shrink-0 items-center justify-center text-mute transition-colors group-hover:text-text', iconClass)}>{icon}</span>
      <span className="flex flex-1 flex-col gap-[3px]">
        <span className="flex items-center gap-2.5 text-[16px] font-medium tracking-[-0.01em]">{title}</span>
        <span className="text-[13px] text-mute">{subtitle}</span>
      </span>
      {!disabled && <IconChevronRight size={18} className="nudge text-faint group-hover:text-text" />}
    </button>
  );
}

function StepHeader({ step, total, title, onBack, children }: { step: number; total: number; title: string; onBack?: () => void; children?: ReactNode }) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        {onBack && (
          <button type="button" aria-label={t('common.back')} onClick={onBack} className="press flex size-9 items-center justify-center rounded-ctl border border-line-2 text-mute hover:border-line-3 hover:bg-raised hover:text-text">
            <IconBack size={16} />
          </button>
        )}
        <span className="eyebrow">
          {t('welcome.stepOf', { step, total })}
        </span>
        <span aria-hidden="true" className="flex gap-1">
          {Array.from({ length: total }, (_, i) => (
            <span key={i} className={cn('h-[3px] w-5 rounded-full transition-colors duration-300', i < step ? 'bg-ice' : 'bg-line-2')} />
          ))}
        </span>
      </div>
      <h1 className="rise m-0 text-[28px] leading-[1.15] font-semibold tracking-[-0.02em]">{title}</h1>
      {children && <p className="rise m-0 max-w-[520px] text-[15px] leading-[1.6] text-mute" style={idx(1)}>{children}</p>}
    </div>
  );
}

function passwordIssues(pw: string, confirm: string): string | null {
  if (pw.length < 10) return t('welcome.pwTooShort');
  if (confirm && pw !== confirm) return t('welcome.pwMismatch');
  return null;
}

function PasswordStep({ busy, error, onSubmit, cta, extra }: { busy: boolean; error: string | null; onSubmit: (pw: string) => void; cta: string; extra?: ReactNode }) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const issue = passwordIssues(pw, confirm);
  const { demo } = useApp();
  const { t } = useT();
  const ok = !issue && confirm === pw && pw.length > 0;
  return (
    <div className="flex max-w-[460px] flex-col gap-4">
      {extra}
      <PasswordField id="pw-new" label={t('shell.vaultPassword')} value={pw} onChange={setPw} autoFocus autoComplete="new-password" />
      <PasswordField id="pw-confirm" label={t('welcome.confirmPassword')} value={confirm} onChange={setConfirm} autoComplete="new-password" invalid={!!confirm && confirm !== pw} onEnter={() => ok && onSubmit(pw)} />
      <p className="m-0 text-[12px] leading-[1.5] text-mute">{issue ?? t('welcome.pwHelp')}</p>
      {demo && <p className="m-0 text-[12px] text-ice-text2">{demoPasswordHint()}</p>}
      {error && <Notice tone="error">{error}</Notice>}
      <Button variant="primary" size="xl" disabled={!ok || busy} onClick={() => onSubmit(pw)} className="mt-1 self-start">
        {busy && <Spinner />} {cta}
      </Button>
    </div>
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

  const create = async (pw: string) => {
    setBusy(true);
    setError(null);
    try {
      // Rust creates the vault and keeps the phrase: it is never sent to this interface.
      const res = await call('vault_create', { password: pw, words: count });
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
      <OnboardingFrame>
        <div className="flex flex-col gap-7">
          <StepHeader step={1} total={3} title={t('welcome.choosePassword')} onBack={onCancel}>
            {t('welcome.choosePasswordIntro')}
          </StepHeader>
          <PasswordStep
            busy={busy}
            error={error}
            onSubmit={create}
            cta={t('welcome.createVault')}
            extra={
              <div className="flex items-center justify-between gap-4">
                <span className="text-[13px] text-text2">{t('welcome.phraseLength')}</span>
                <Segmented label={t('welcome.wordCount')} value={count} onChange={(v) => setCount(v)} options={[{ value: 24, label: t('welcome.words24') }, { value: 12, label: t('welcome.words12') }]} />
              </div>
            }
          />
        </div>
      </OnboardingFrame>
    );
  }

  if (step === 'phrase') {
    return (
      <OnboardingFrame>
        <div className="flex flex-col gap-6">
          <StepHeader step={2} total={3} title={t('welcome.writeTitle')}>
            {t('welcome.writeIntro', { count: wordCount })}
          </StepHeader>
          <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
            {t('welcome.writeWarn')}
          </Notice>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant={seen ? 'secondary' : 'primary'} size="xl" disabled={busy} onClick={() => void show()}>
              {busy && <Spinner />} {busy ? t('common.systemWindowOpen') : seen ? t('welcome.showAgain') : t('welcome.showPhrase')}
            </Button>
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          <label className="flex items-center gap-3 text-[14px]">
            <input type="checkbox" checked={written} disabled={!seen} onChange={(e) => setWritten(e.target.checked)} className="size-4" />
            {t('welcome.wroteWords', { count: wordCount })}
          </label>
          <Button variant="primary" size="xl" className="self-start" disabled={!seen || !written || busy} onClick={goVerify}>
            {t('welcome.verifyBackup')}
          </Button>
        </div>
      </OnboardingFrame>
    );
  }

  return (
    <OnboardingFrame>
      <div className="flex flex-col gap-6">
        <StepHeader step={3} total={3} title={t('welcome.verifyTitle')} onBack={() => setStep('phrase')}>
          {t('welcome.verifyIntro')}
        </StepHeader>
        <div className="flex max-w-[520px] flex-col gap-3">
          {checks.map((index, i) => (
            <WordInput
              key={index}
              index={index}
              value={answers[i] ?? ''}
              onChange={(v) => setAnswers((a) => a.map((x, j) => (j === i ? v : x)))}
              autoFocus={i === 0}
              onEnter={() => void verify()}
            />
          ))}
        </div>
        {verifyError && <Notice tone="error">{verifyError}</Notice>}
        <div className="flex gap-2">
          {giveUp ? (
            <Button variant="primary" size="xl" onClick={() => void continueUnverified()}>
              {t('welcome.continueUnverified')}
            </Button>
          ) : (
            <>
              <Button variant="primary" size="xl" disabled={busy || answers.some((a) => !a.trim())} onClick={() => void verify()}>
                {busy && <Spinner />} {t('welcome.finish')}
              </Button>
              <Button
                variant="secondary"
                size="xl"
                onClick={() => {
                  setSeen(false);
                  setWritten(false);
                  setStep('phrase');
                }}
              >
                {t('welcome.reviewPhrase')}
              </Button>
            </>
          )}
        </div>
      </div>
    </OnboardingFrame>
  );
}

/** Word field with BIP39 autocomplete (English wordlist). */
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
      <label className={cn('flex items-center gap-2.5 rounded-ctl border bg-card px-3 transition-colors focus-within:border-ice-line', compact ? 'h-10' : 'h-12', invalid ? 'border-down/60' : 'border-line hover:border-line-2')}>
        <span className="w-6 font-mono text-[11px] text-faint">{index + 1}</span>
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
          className="min-w-0 flex-1 bg-transparent font-mono text-[15px]"
        />
        {known && <span className="text-[11px] text-up">✓</span>}
      </label>
      {show && (
        <div className="pop-in absolute top-full right-0 left-0 z-20 mt-1 flex gap-1 rounded-ctl border border-line-2 bg-[#121418] p-1">
          {suggestions.map((s) => (
            <button key={s} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onChange(s)} className="rounded-[7px] px-2 py-1 font-mono text-[12px] text-text2 hover:bg-control">
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
      await call('vault_import', { password: pw, phrase, xmrRestore: xmrRestore ?? { kind: 'kyro' } });
      setWords([]);
      setBackupState('imported');
      await enterVault();
    } catch (e) {
      setError(toIpcError(e).message);
      setBusy(false);
    }
  };

  if (step === 'password') {
    return (
      <OnboardingFrame>
        <div className="flex flex-col gap-7">
          <StepHeader step={2} total={2} title={t('welcome.protectTitle')} onBack={() => setStep('phrase')}>
            {t('welcome.protectIntro')}
          </StepHeader>
          <PasswordStep busy={busy} error={error} onSubmit={(pw) => void submit(pw)} cta={t('welcome.import')} />
        </div>
      </OnboardingFrame>
    );
  }

  return (
    <OnboardingFrame status={<span className="text-warn">{t('welcome.captureBlocked')}</span>}>
      <div className="flex flex-col gap-6">
        <StepHeader step={1} total={2} title={t('welcome.importTitle')} onBack={onCancel}>
          {t('welcome.importIntro')}
        </StepHeader>
        <Segmented className="self-start" label={t('welcome.wordCount')} value={count} onChange={resize} options={[{ value: 12, label: t('welcome.words12') }, { value: 24, label: t('welcome.words24') }]} />
        <div className={cn('grid max-w-[680px] gap-2', count === 24 ? 'grid-cols-4' : 'grid-cols-3')}>
          {words.map((w, i) => (
            <WordInput key={`${count}-${i}`} compact index={i} value={w} autoFocus={i === 0} onChange={(v) => setWords((ws) => ws.map((x, j) => (j === i ? v : x)))} onPasteMany={(parts) => pasteMany(i, parts)} />
          ))}
        </div>
        <div className="text-[13px]">
          {unknown > 0 ? (
            <span className="text-down">{t('welcome.unknownWords', { count: unknown })}</span>
          ) : filled && !valid ? (
            <span className="text-down">{t('welcome.badChecksum')}</span>
          ) : valid ? (
            <span className="text-up">{t('welcome.validPhrase')}</span>
          ) : (
            <span className="text-mute">{t('welcome.wordsStayHere')}</span>
          )}
        </div>
        <div className="flex max-w-[680px] flex-col gap-2.5 rounded-box border border-line bg-raised px-4 py-3 text-[13px]">
          <span className="text-mute">{t('welcome.xmrDefault')}</span>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={xmrLedger} onChange={(e) => setXmrLedger(e.target.checked)} className="size-4" />
            {t('welcome.xmrLedger')}
          </label>
          {xmrLedger && (
            <>
              <Segmented className="self-start" label={t('welcome.xmrLedger')} value={xmrMode} onChange={setXmrMode} options={[{ value: 'date', label: t('welcome.xmrFromDate') }, { value: 'genesis', label: t('welcome.xmrFromGenesis') }]} />
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
        <Button variant="primary" size="xl" className="self-start" disabled={!valid || xmrRestore === null} onClick={() => setStep('password')}>
          {t('common.continue')}
        </Button>
      </div>
    </OnboardingFrame>
  );
}
