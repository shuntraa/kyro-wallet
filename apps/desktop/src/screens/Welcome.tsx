// SPDX-License-Identifier: GPL-3.0-or-later
// Onboarding: create a vault (24 words shown once, 3-word check) or import a
// BIP39 phrase (wordlist autocomplete). Hardware wallets: coming soon.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { call, toIpcError } from '@kyro/shared';
import { outgoingHosts } from '@kyro/chains';
import { useApp } from '../state/app';
import { setBackupState } from '../lib/storage';
import { cn } from '../lib/cn';
import { TitleBar } from '../shell/TitleBar';
import { StatusFrame } from '../shell/StatusBar';
import { KyroMark, PasswordField } from '../components/kit';
import { Button, Notice, Segmented, Spinner } from '../components/ui/primitives';
import { Dialog } from '../components/ui/dialog';
import { HwSetup } from '../components/hw';
import { IconBack, IconChevronRight, IconImport, IconPlus, IconUsbKey, IconWarn } from '../components/icons';
import { DEMO_PASSWORD_HINT } from './demoHint';
import { idx } from '../components/motion';

/** Onboarding side panel: the logo and the name, nothing decorative. */
function BrandPanel() {
  return (
    <section aria-hidden="true" className="flex w-[40%] max-w-[560px] min-w-[360px] shrink-0 flex-col items-center justify-center gap-5 border-r border-rail bg-panel">
      <KyroMark size={88} />
      <span className="text-[22px] font-semibold tracking-[-0.02em]">Kyro</span>
    </section>
  );
}

export function OnboardingFrame({ children, status }: { children: ReactNode; status?: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <TitleBar bordered={false} />
      <div className="flex min-h-0 flex-1">
        <BrandPanel />
        <main className="flex min-w-0 flex-1 flex-col justify-center overflow-y-auto px-[min(88px,6.5vw)] py-8 scroll-thin">{children}</main>
      </div>
      <StatusFrame left={status ?? <span className="text-mute">Aucun coffre sur cet appareil</span>} />
    </div>
  );
}

type Mode = 'home' | 'create' | 'import' | 'hw';

export function Welcome() {
  const [mode, setMode] = useState<Mode>('home');
  const [info, setInfo] = useState<null | 'threat' | 'code' | 'network'>(null);
  const { network, enterVault } = useApp();

  if (mode === 'create') return <CreateFlow onCancel={() => setMode('home')} />;
  if (mode === 'import') return <ImportFlow onCancel={() => setMode('home')} />;
  if (mode === 'hw') {
    return (
      <OnboardingFrame status={<span className="text-mute">Hardware wallet seul : pas de coffre ni de mot de passe Kyro</span>}>
        <div className="flex max-w-[600px] flex-col gap-6">
          <StepHeader step={1} total={1} title="Utiliser un Ledger ou une Trezor" onBack={() => setMode('home')}>
            Tes clés restent dans l’appareil. Kyro n’enregistre que des clés publiques ; chaque transaction se confirme sur l’écran de l’appareil. Pas de coffre ni de mot de passe Kyro dans ce mode.
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
            Bienvenue sur Kyro
          </h1>
          <p className="rise m-0 max-w-[440px] text-[15px] leading-[1.6] text-mute" style={idx(1)}>Choisis comment tu veux commencer. Tes clés restent sur cet ordinateur ou dans ton hardware wallet.</p>
        </div>

        <div className="rise flex max-w-[540px] flex-col border-t border-line" style={idx(2)}>
          <ChoiceCard
            icon={<IconUsbKey size={20} />}
            iconClass="text-ice"
            title="Utiliser un Ledger / Trezor"
            subtitle="Recommandé. Tes clés ne quittent jamais l’appareil ; chaque transaction se vérifie sur son écran."
            onClick={() => setMode('hw')}
          />
          <ChoiceCard icon={<IconPlus size={20} />} title="Créer un nouveau coffre" subtitle="24 mots à écrire sur papier, jamais copiés." onClick={() => setMode('create')} />
          <ChoiceCard icon={<IconImport size={20} />} title="Importer une phrase de récupération" subtitle="12 ou 24 mots BIP39, depuis un autre wallet." onClick={() => setMode('import')} />
        </div>

        <div className="rise flex gap-6 text-[13px]" style={idx(3)}>
          {(
            [
              ['threat', 'Modèle de menace'],
              ['code', 'Code source'],
              ['network', 'Requêtes réseau'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" className="text-mute underline decoration-line-3 underline-offset-[5px] transition-colors hover:text-text hover:decoration-ice" onClick={() => setInfo(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <Dialog open={info === 'threat'} onOpenChange={() => setInfo(null)} title="Modèle de menace">
        <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-[13px] leading-[1.55] text-text2">
          <li>Ta phrase est chiffrée sur cet appareil (Argon2id + XChaCha20-Poly1305). Sans ton mot de passe, le fichier du coffre est inutilisable.</li>
          <li>L’interface ne voit jamais tes clés : la dérivation et les signatures se font dans le noyau Rust.</li>
          <li>Chaque signature redemande ton mot de passe et affiche une fenêtre système avec le résumé décodé par le noyau.</li>
          <li>Kyro ne protège pas contre un appareil déjà compromis (enregistreur de frappe, accès root). Pour cela : un hardware wallet.</li>
        </ul>
      </Dialog>
      <Dialog open={info === 'code'} onOpenChange={() => setInfo(null)} title="Code source">
        <p className="m-0 text-[13px] leading-[1.55] text-text2">Kyro est un logiciel libre sous licence GPL-3.0-or-later. Tout le code (interface, noyau, coquille Tauri) est publié et le build est vérifiable : ce que tu installes correspond au code publié.</p>
      </Dialog>
      <Dialog open={info === 'network'} onOpenChange={() => setInfo(null)} title="Requêtes réseau" description="La liste complète des serveurs que Kyro peut contacter. Tout le reste est bloqué par le noyau.">
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

/** One row of the welcome list: numbered, ruled, no box. */
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
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        {onBack && (
          <button type="button" aria-label="Retour" onClick={onBack} className="press flex size-9 items-center justify-center rounded-ctl border border-line-2 text-mute hover:border-line-3 hover:bg-raised hover:text-text">
            <IconBack size={16} />
          </button>
        )}
        <span className="eyebrow">
          Étape {step} sur {total}
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
  if (pw.length < 8) return 'Au moins 8 caractères (une phrase de 4 mots, c’est mieux).';
  if (confirm && pw !== confirm) return 'Les deux mots de passe ne correspondent pas.';
  return null;
}

function PasswordStep({ busy, error, onSubmit, cta, extra }: { busy: boolean; error: string | null; onSubmit: (pw: string) => void; cta: string; extra?: ReactNode }) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const issue = passwordIssues(pw, confirm);
  const { demo } = useApp();
  const ok = !issue && confirm === pw && pw.length > 0;
  return (
    <div className="flex max-w-[460px] flex-col gap-4">
      {extra}
      <PasswordField id="pw-new" label="Mot de passe du coffre" value={pw} onChange={setPw} autoFocus autoComplete="new-password" />
      <PasswordField id="pw-confirm" label="Confirme le mot de passe" value={confirm} onChange={setConfirm} autoComplete="new-password" invalid={!!confirm && confirm !== pw} onEnter={() => ok && onSubmit(pw)} />
      <p className="m-0 text-[12px] leading-[1.5] text-mute">{issue ?? 'Il chiffre le coffre sur cet appareil et sera demandé à chaque signature. Kyro ne peut pas le récupérer.'}</p>
      {demo && <p className="m-0 text-[12px] text-ice-text2">{DEMO_PASSWORD_HINT}</p>}
      {error && <Notice tone="error">{error}</Notice>}
      <Button variant="primary" size="xl" disabled={!ok || busy} onClick={() => onSubmit(pw)} className="mt-1 self-start">
        {busy && <Spinner />} {cta}
      </Button>
    </div>
  );
}

/** Capture protection on while the phrase is on screen; restored on unmount. */
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

function randomIndexes(n: number, count: number): number[] {
  const out = new Set<number>();
  const buf = new Uint32Array(1);
  while (out.size < Math.min(count, n)) {
    crypto.getRandomValues(buf);
    out.add((buf[0] ?? 0) % n);
  }
  return [...out].sort((a, b) => a - b);
}

function CreateFlow({ onCancel }: { onCancel: () => void }) {
  const { enterVault } = useApp();
  const [step, setStep] = useState<'password' | 'phrase' | 'verify'>('password');
  const [count, setCount] = useState<12 | 24>(24);
  const [words, setWords] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [written, setWritten] = useState(false);
  const [checks, setChecks] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  useCaptureProtection(step !== 'password');
  // Never keep the phrase after leaving the flow.
  useEffect(() => () => setWords([]), []);

  const create = async (pw: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await call('vault_create', { password: pw, words: count });
      setWords(res.words);
      setStep('phrase');
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const goVerify = () => {
    setChecks(randomIndexes(words.length, 3));
    setAnswers(['', '', '']);
    setVerifyError(null);
    setStep('verify');
  };

  const verify = async () => {
    const ok = checks.every((idx, i) => (answers[i] ?? '').trim().toLowerCase() === words[idx]);
    if (!ok) {
      setVerifyError('Un ou plusieurs mots ne correspondent pas. Vérifie ta feuille, ou reviens à la phrase.');
      return;
    }
    setBackupState('confirmed');
    setWords([]);
    await enterVault();
  };

  if (step === 'password') {
    return (
      <OnboardingFrame>
        <div className="flex flex-col gap-7">
          <StepHeader step={1} total={3} title="Choisis ton mot de passe" onBack={onCancel}>
            Ensuite, Kyro génère ta phrase de récupération. Elle ne sera affichée qu’une seule fois.
          </StepHeader>
          <PasswordStep
            busy={busy}
            error={error}
            onSubmit={create}
            cta="Créer le coffre"
            extra={
              <div className="flex items-center justify-between gap-4">
                <span className="text-[13px] text-text2">Longueur de la phrase</span>
                <Segmented label="Nombre de mots" value={count} onChange={(v) => setCount(v)} options={[{ value: 24, label: '24 mots' }, { value: 12, label: '12 mots' }]} />
              </div>
            }
          />
        </div>
      </OnboardingFrame>
    );
  }

  if (step === 'phrase') {
    return (
      <OnboardingFrame status={<span className="text-warn">Captures d’écran bloquées pendant l’affichage</span>}>
        <div className="flex flex-col gap-6">
          <StepHeader step={2} total={3} title="Écris ces mots sur papier">
            Dans l’ordre, au stylo. Pas de photo, pas de copie, pas de cloud. Quiconque lit ces {words.length} mots contrôle tes fonds.
          </StepHeader>
          <ol className={cn('stagger m-0 grid max-w-[640px] list-none gap-2 p-0', words.length === 24 ? 'grid-cols-4' : 'grid-cols-3')}>
            {words.map((w, i) => (
              <li key={i} className="flex h-11 items-center gap-2.5 rounded-ctl border border-line bg-card px-3" style={idx(i)}>
                <span className="w-5 font-mono text-[11px] text-faint">{String(i + 1).padStart(2, '0')}</span>
                <span className="font-mono text-[15px] font-medium">{w}</span>
              </li>
            ))}
          </ol>
          <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
            Il n’y a pas de bouton « Copier » : c’est volontaire. Kyro ne pourra plus jamais te réafficher cette phrase sans ton mot de passe.
          </Notice>
          <label className="flex items-center gap-3 text-[14px]">
            <input type="checkbox" checked={written} onChange={(e) => setWritten(e.target.checked)} className="size-4" />
            J’ai écrit les {words.length} mots, dans l’ordre.
          </label>
          <Button variant="primary" size="xl" className="self-start" disabled={!written} onClick={goVerify}>
            Vérifier ma sauvegarde
          </Button>
        </div>
      </OnboardingFrame>
    );
  }

  return (
    <OnboardingFrame>
      <div className="flex flex-col gap-6">
        <StepHeader step={3} total={3} title="Vérifie trois mots" onBack={() => setStep('phrase')}>
          Pour être sûr que ta feuille est juste, saisis les mots demandés.
        </StepHeader>
        <div className="flex max-w-[520px] flex-col gap-3">
          {checks.map((idx, i) => (
            <WordInput
              key={idx}
              index={idx}
              value={answers[i] ?? ''}
              onChange={(v) => setAnswers((a) => a.map((x, j) => (j === i ? v : x)))}
              autoFocus={i === 0}
              onEnter={() => void verify()}
            />
          ))}
        </div>
        {verifyError && <Notice tone="error">{verifyError}</Notice>}
        <div className="flex gap-2">
          <Button variant="primary" size="xl" disabled={answers.some((a) => !a.trim())} onClick={() => void verify()}>
            Terminer
          </Button>
          <Button variant="secondary" size="xl" onClick={() => setStep('phrase')}>
            Revoir la phrase
          </Button>
        </div>
      </div>
    </OnboardingFrame>
  );
}

/** Word field with BIP39 autocomplete (English wordlist). */
function WordInput({ index, value, onChange, autoFocus, onEnter, onPasteMany, compact }: { index: number; value: string; onChange: (v: string) => void; autoFocus?: boolean; onEnter?: () => void; onPasteMany?: (words: string[]) => void; compact?: boolean }) {
  const [focused, setFocused] = useState(false);
  const v = value.trim().toLowerCase();
  const suggestions = useMemo(() => (v.length >= 1 ? wordlist.filter((w) => w.startsWith(v)).slice(0, 4) : []), [v]);
  const known = v.length > 0 && wordlist.includes(v);
  const invalid = v.length > 0 && !known && suggestions.length === 0;
  const show = focused && suggestions.length > 0 && !(suggestions.length === 1 && suggestions[0] === v);
  return (
    <div className="relative">
      <label className={cn('flex items-center gap-2.5 rounded-ctl border bg-card px-3 transition-colors focus-within:border-ice-line', compact ? 'h-10' : 'h-12', invalid ? 'border-down/60' : 'border-line hover:border-line-2')}>
        <span className="w-6 font-mono text-[11px] text-faint">{index + 1}</span>
        <span className="sr-only">Mot {index + 1}</span>
        <input
          value={value}
          aria-label={`Mot ${index + 1}`}
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

  useCaptureProtection(true);
  // No unmount cleanup clearing `words`: StrictMode's mount/unmount/remount ran it right away and
  // left the grid empty. The state dies with the component; `submit` clears it explicitly.

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
      await call('vault_import', { password: pw, phrase });
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
          <StepHeader step={2} total={2} title="Protège ce coffre" onBack={() => setStep('phrase')}>
            Choisis un mot de passe pour chiffrer la phrase importée sur cet appareil.
          </StepHeader>
          <PasswordStep busy={busy} error={error} onSubmit={(pw) => void submit(pw)} cta="Importer" />
        </div>
      </OnboardingFrame>
    );
  }

  return (
    <OnboardingFrame status={<span className="text-warn">Captures d’écran bloquées pendant la saisie</span>}>
      <div className="flex flex-col gap-6">
        <StepHeader step={1} total={2} title="Importer une phrase" onBack={onCancel}>
          Saisis tes mots BIP39 (anglais) dans l’ordre. Tu peux coller la phrase entière dans la première case.
        </StepHeader>
        <Segmented className="self-start" label="Nombre de mots" value={count} onChange={resize} options={[{ value: 12, label: '12 mots' }, { value: 24, label: '24 mots' }]} />
        <div className={cn('grid max-w-[680px] gap-2', count === 24 ? 'grid-cols-4' : 'grid-cols-3')}>
          {words.map((w, i) => (
            <WordInput key={`${count}-${i}`} compact index={i} value={w} autoFocus={i === 0} onChange={(v) => setWords((ws) => ws.map((x, j) => (j === i ? v : x)))} onPasteMany={(parts) => pasteMany(i, parts)} />
          ))}
        </div>
        <div className="text-[13px]">
          {unknown > 0 ? (
            <span className="text-down">{unknown} mot(s) hors de la liste BIP39.</span>
          ) : filled && !valid ? (
            <span className="text-down">Somme de contrôle invalide : un mot est faux ou mal placé.</span>
          ) : valid ? (
            <span className="text-up">✓ Phrase valide.</span>
          ) : (
            <span className="text-mute">Les mots restent sur cet appareil et sont effacés de l’écran après l’import.</span>
          )}
        </div>
        <Button variant="primary" size="xl" className="self-start" disabled={!valid} onClick={() => setStep('password')}>
          Continuer
        </Button>
      </div>
    </OnboardingFrame>
  );
}
