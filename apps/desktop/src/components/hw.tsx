// SPDX-License-Identifier: GPL-3.0-or-later
//
// Hardware wallets (Ledger, Trezor): device badge, waiting state with Cancel, error notice,
// the full-screen stop for HW_ADDRESS_MISMATCH, the Trezor One blind PIN matrix (global), and
// the add-device flow (Welcome and Réglages › Appareils). Contract: docs/IPC.md §2.3.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { call, errorData, isDemoMode, MAX_HW_ACCOUNT, type HwChain, type HwChainStatus, type HwDeviceInfo, type HwDeviceKind, type HwDeviceStatus, type HwImplementedChain, type WatchOnlyAccount } from '@kyro/shared';
import { hwFingerprint, hwToAccounts } from '@kyro/chains';
import { BRAND, hwErrorView, hwPromptStore, pinPosition, useHwPrompts, withDevice, PIN_MATRIX_KEYPAD } from '../state/hw';
import { cn } from '../lib/cn';
import { shortAddress } from '../lib/format';
import { Dialog } from './ui/dialog';
import { Badge, Button, Input, Notice, Spinner } from './ui/primitives';
import { IconCheck, IconInfo, IconPhoneKey, IconRefresh, IconUsbKey, IconWarn, IconX } from './icons';

// ---------------------------------------------------------------- small pieces

export function DeviceBadge({ device, model, className }: { device: HwDeviceKind; model?: string; className?: string }) {
  return (
    <Badge tone="ice" className={cn('gap-1', className)}>
      {device === 'ledger' ? <IconUsbKey size={11} /> : <IconPhoneKey size={11} />}
      {model ?? BRAND[device]}
    </Badge>
  );
}

const PROMPT_TEXT: Record<string, { title: string; detail: string }> = {
  'confirm-on-device': { title: 'Confirme sur ton appareil', detail: 'Vérifie les informations sur l’écran de l’appareil, puis confirme-les là-bas. S’il affiche autre chose, refuse sur l’appareil.' },
  'pin-on-device': { title: 'Saisis ton PIN sur l’appareil', detail: 'Le PIN se tape sur l’appareil lui-même : il ne passe jamais par l’ordinateur.' },
  'passphrase-on-device': { title: 'Saisis ta passphrase sur l’appareil', detail: 'La passphrase se tape sur l’appareil : Kyro ne la voit jamais.' },
  'pin-matrix': { title: 'Saisis ton PIN dans la grille', detail: 'Regarde l’écran de ta Trezor et clique les cases aux mêmes positions.' },
};

/** "Waiting for the device" panel with Cancel (`hw_cancel`). */
export function HwWaiting({ deviceId, idle, className, confirm }: { deviceId: string; idle?: string; className?: string; confirm?: { title: string; detail: string } }) {
  const prompt = useHwPrompts().byDevice[deviceId];
  const [cancelling, setCancelling] = useState(false);
  const t = prompt === 'confirm-on-device' && confirm ? confirm : prompt ? PROMPT_TEXT[prompt] : null;
  return (
    <div role="status" aria-live="polite" className={cn('flex items-start gap-3.5 rounded-[16px] border border-ice-line bg-ice/[.06] px-4 py-3.5', className)}>
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-ice/12 text-ice">
        <Spinner className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-semibold text-text">{t?.title ?? idle ?? 'Communication avec l’appareil…'}</span>
        <span className="text-[12px] leading-[1.5] text-mute">{t?.detail ?? 'Garde l’appareil branché et déverrouillé.'}</span>
      </span>
      <Button
        size="sm"
        onClick={() => {
          setCancelling(true);
          void call('hw_cancel', { id: deviceId })
            .catch(() => undefined)
            .finally(() => setCancelling(false));
        }}
        disabled={cancelling}
      >
        {cancelling && <Spinner />} Annuler
      </Button>
    </div>
  );
}

export function HwErrorNotice({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const v = hwErrorView(error);
  return (
    <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />} {...(className ? { className } : {})}>
      <span className="block font-semibold">{v.title}</span>
      <span className="block">{v.detail}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-1.5 font-semibold text-ice hover:underline">
          Réessayer
        </button>
      )}
    </Notice>
  );
}

/** HW_ADDRESS_MISMATCH: a full-screen red stop. The address must not be used. */
export function AddressMismatchStop({ error, onClose }: { error: unknown; onClose: () => void }) {
  const d = errorData(error, 'HW_ADDRESS_MISMATCH');
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="mismatch-title" className="fixed inset-0 z-[60] flex items-center justify-center bg-[#2a0707]/95 p-8 backdrop-blur-[2px]">
      <div className="flex max-w-[640px] flex-col gap-5 rounded-[22px] border-2 border-down bg-[#1a0a0a] p-8">
        <span className="flex size-14 items-center justify-center rounded-full bg-down/20 text-down">
          <IconWarn size={28} />
        </span>
        <h1 id="mismatch-title" className="m-0 text-[30px] leading-[1.15] font-semibold tracking-[-0.03em] text-[#ffd6d6]">
          Ne reçois pas de fonds sur cette adresse
        </h1>
        <p className="m-0 text-[15px] leading-[1.6] text-[#ffc2c2]">
          L’adresse affichée par ton appareil n’est pas celle que Kyro a calculée. Quelqu’un a peut-être modifié les comptes enregistrés sur cet ordinateur, ou ce n’est pas le bon appareil. N’envoie et ne communique aucune de ces deux adresses.
        </p>
        {d && (
          <dl className="m-0 flex flex-col gap-2 rounded-[14px] border border-down/40 bg-black/30 p-4 font-mono text-[12px]">
            <div className="flex flex-col gap-0.5">
              <dt className="font-sans text-[12px] text-[#ff9a9a]">Affichée par l’appareil</dt>
              <dd className="m-0 break-all text-[#ffd6d6]">{d.device}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="font-sans text-[12px] text-[#ff9a9a]">Calculée par Kyro</dt>
              <dd className="m-0 break-all text-[#ffd6d6]">{d.expected}</dd>
            </div>
          </dl>
        )}
        <p className="m-0 text-[13px] leading-[1.55] text-[#ff9a9a]">Supprime ce compte dans Réglages › Appareils puis ajoute-le de nouveau depuis l’appareil. Si le problème persiste, n’utilise pas cet appareil.</p>
        <div>
          <Button variant="danger" onClick={onClose}>
            J’ai compris
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Trezor One PIN matrix (global)

/** Mounted once at the root: answers `hw-prompt: pin-matrix` with positions only. */
export function HwPromptLayer() {
  const { byDevice } = useHwPrompts();
  const id = Object.entries(byDevice).find(([, k]) => k === 'pin-matrix')?.[0] ?? null;
  return <PinMatrixDialog deviceId={id} />;
}

export function PinMatrixDialog({ deviceId }: { deviceId: string | null }) {
  const [positions, setPositions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [demoLayout, setDemoLayout] = useState<number[][] | null>(null);
  useEffect(() => {
    setPositions('');
    setError(null);
  }, [deviceId]);
  useEffect(() => {
    if (!deviceId || !isDemoMode()) return;
    void import('@kyro/shared/mock').then((m) => setDemoLayout(m.DEMO_TREZOR_LAYOUT));
  }, [deviceId]);
  if (!deviceId) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('hw_pin_matrix', { id: deviceId, positions });
      hwPromptStore.clear(deviceId);
    } catch (e) {
      setError(e);
    } finally {
      setPositions('');
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : void call('hw_cancel', { id: deviceId }).catch(() => undefined))} title="PIN de la Trezor One" className="w-[440px]">
      <p className="m-0 text-[13px] leading-[1.55] text-text2">
        Ta Trezor affiche ses chiffres dans un ordre mélangé. Clique ici les cases <strong className="font-semibold text-text">aux mêmes positions</strong> que les chiffres de ton PIN sur l’écran de l’appareil. Kyro ne reçoit que des positions, inutiles sans l’appareil : jamais ton PIN.
      </p>
      <div className="flex items-start justify-center gap-6">
        <div role="group" aria-label="Grille du PIN (cases vierges)" className="grid grid-cols-3 gap-2">
          {PIN_MATRIX_KEYPAD.map((row, r) =>
            row.map((_, c) => (
              <button
                key={`${r}-${c}`}
                type="button"
                aria-label={`Case ligne ${r + 1}, colonne ${c + 1}`}
                disabled={busy || positions.length >= 9}
                onClick={() => setPositions((p) => p + pinPosition(r, c))}
                className="flex size-16 items-center justify-center rounded-[14px] border border-line-2 bg-raised text-[22px] text-faint hover:border-ice-line hover:bg-control"
              >
                •
              </button>
            )),
          )}
        </div>
        {demoLayout && (
          <div className="flex flex-col items-center gap-1.5" aria-label="Écran simulé de l’appareil">
            <span className="text-[11px] font-semibold tracking-[0.04em] text-ice uppercase">Mode démo</span>
            <div className="grid grid-cols-3 gap-1 rounded-[10px] border border-line bg-black p-2 font-mono text-[14px] text-text">
              {demoLayout.flat().map((n, i) => (
                <span key={i} className="flex size-7 items-center justify-center">
                  {n}
                </span>
              ))}
            </div>
            <span className="max-w-[120px] text-center text-[11px] text-faint">écran simulé · PIN démo 1234</span>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between">
        <span aria-label={`${positions.length} positions saisies`} className="font-mono text-[18px] tracking-[0.3em] text-text">
          {positions.length ? '•'.repeat(positions.length) : <span className="text-[12px] tracking-normal text-faint">aucune case saisie</span>}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setPositions((p) => p.slice(0, -1))} disabled={!positions || busy}>
          Effacer
        </Button>
      </div>
      {error !== null && <HwErrorNotice error={error} />}
      <p className="m-0 flex items-start gap-2 text-[12px] leading-[1.5] text-mute">
        <IconInfo size={14} className="mt-0.5 shrink-0 text-faint" />
        Passphrase : sur la Trezor One, elle se taperait sur l’ordinateur. Kyro refuse pour qu’aucun secret ne transite par l’interface ; désactive-la ou utilise une Trezor T / Safe (saisie sur l’appareil).
      </p>
      <div className="flex justify-end gap-2">
        <Button onClick={() => void call('hw_cancel', { id: deviceId }).catch(() => undefined)} disabled={busy}>
          Annuler
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={positions.length < 1 || busy}>
          {busy && <Spinner />} Valider
        </Button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- add a device

const CHAIN_LABEL: Record<HwChain, string> = { btc: 'Bitcoin', evm: 'Ethereum et EVM', sol: 'Solana', ltc: 'Litecoin', doge: 'Dogecoin', tron: 'TRON', cardano: 'Cardano', xrp: 'XRP' };
const IMPLEMENTED: HwImplementedChain[] = ['btc', 'evm', 'sol'];

type Step = 'detect' | 'device' | 'reading' | 'done';

/** Step list: detect → open (unlock / app) → chains and account → read + save → summary. */
export function HwSetup({ onDone, onCancel }: { onDone: (acc: WatchOnlyAccount) => void; onCancel?: () => void }) {
  const [step, setStep] = useState<Step>('detect');
  const [devices, setDevices] = useState<HwDeviceInfo[] | null>(null);
  const [device, setDevice] = useState<HwDeviceInfo | null>(null);
  const [status, setStatus] = useState<HwDeviceStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [chains, setChains] = useState<Set<HwImplementedChain>>(new Set(['btc', 'evm']));
  const [account, setAccount] = useState('0');
  const [label, setLabel] = useState('');
  const [progress, setProgress] = useState<Partial<Record<HwImplementedChain, 'todo' | 'reading' | 'ok' | 'error'>>>({});
  const [saved, setSaved] = useState<WatchOnlyAccount | null>(null);

  const detect = async () => {
    setBusy('detect');
    setError(null);
    let only: HwDeviceInfo | null = null;
    try {
      const list = await call('hw_list');
      setDevices(list);
      if (list.length === 1 && list[0]) only = list[0];
    } catch (e) {
      setError(e);
    }
    setBusy(null);
    // A single device: open it right away (after clearing `busy`, which `open` sets again).
    if (only) void open(only);
  };

  // Once (StrictMode runs effects twice in dev: a 2nd hw_open would be HW_BUSY).
  const detected = useRef(false);
  useEffect(() => {
    if (detected.current) return;
    detected.current = true;
    void detect();
  }, []);

  const open = async (d: HwDeviceInfo) => {
    setDevice(d);
    setStep('device');
    setBusy('open');
    setError(null);
    try {
      const st = await withDevice(d.id, () => call('hw_open', { id: d.id }));
      setStatus(st);
      // Default selection: every implemented chain the device supports.
      setChains(new Set(IMPLEMENTED.filter((c) => st.chains.find((x) => x.chain === c)?.state !== 'unsupported')));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const accountNumber = /^\d+$/.test(account) ? Number(account) : NaN;
  const accountValid = Number.isInteger(accountNumber) && accountNumber >= 0 && accountNumber <= MAX_HW_ACCOUNT;

  /** Per chain: read the public keys (hw_get_xpub), then save them (hw_account_add), while the right app is open. */
  const read = async (from?: HwImplementedChain) => {
    if (!device || !accountValid) return;
    setStep('reading');
    setError(null);
    const order = IMPLEMENTED.filter((c) => chains.has(c));
    const start = from ? order.indexOf(from) : 0;
    let acc = from ? saved : null;
    setProgress((p) => Object.fromEntries(order.map((c, i) => [c, i < start ? (p[c] ?? 'ok') : 'todo'])));
    for (const chain of order.slice(start)) {
      setProgress((p) => ({ ...p, [chain]: 'reading' }));
      setBusy(chain);
      try {
        await withDevice(device.id, () => call('hw_get_xpub', { id: device.id, chain, account: accountNumber }));
        acc = await withDevice(device.id, () =>
          call('hw_account_add', { id: device.id, chain, account: accountNumber, ...(acc ? { accountId: acc.id } : {}), ...(label.trim() ? { label: label.trim() } : {}) }),
        );
        setSaved(acc);
        setProgress((p) => ({ ...p, [chain]: 'ok' }));
      } catch (e) {
        setProgress((p) => ({ ...p, [chain]: 'error' }));
        setError({ error: e, chain });
        setBusy(null);
        return;
      }
    }
    setBusy(null);
    if (acc) {
      setSaved(acc);
      setStep('done');
    }
  };

  const failed = error && typeof error === 'object' && 'chain' in error ? (error as { error: unknown; chain: HwImplementedChain }) : null;

  return (
    <div className="flex flex-col gap-4">
      <ol className="m-0 flex list-none gap-2 p-0 text-[12px]" aria-label="Étapes">
        {(['Détecter', 'Déverrouiller et ouvrir l’app', 'Lire les clés', 'Terminé'] as const).map((s, i) => {
          const idx = ['detect', 'device', 'reading', 'done'].indexOf(step);
          return (
            <li key={s} aria-current={idx === i ? 'step' : undefined} className={cn('flex items-center gap-1.5 rounded-full px-3 py-1', idx === i ? 'bg-ice/12 font-semibold text-ice-text' : idx > i ? 'text-up' : 'text-faint')}>
              {idx > i ? <IconCheck size={12} /> : <span className="font-mono">{i + 1}</span>} {s}
            </li>
          );
        })}
      </ol>

      {step === 'detect' && (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[14px] leading-[1.55] text-text2">Branche ton Ledger ou ta Trezor en USB et déverrouille-le. Kyro ne lit que des clés publiques : tes clés privées ne quittent jamais l’appareil.</p>
          {busy === 'detect' && (
            <span className="flex items-center gap-2 text-[13px] text-mute">
              <Spinner /> Recherche des appareils…
            </span>
          )}
          {devices && devices.length === 0 && busy !== 'detect' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              <span className="block font-semibold text-text">Aucun appareil détecté</span>
              <span className="block">Branche-le (câble de données, pas seulement de charge), déverrouille-le, et ferme Ledger Live ou Trezor Suite qui peuvent garder l’USB. Sous Linux, les règles udev du fabricant sont nécessaires.</span>
            </Notice>
          )}
          {devices && devices.length > 1 && (
            <div className="flex flex-col gap-2">
              {devices.map((d) => (
                <button key={d.id} type="button" onClick={() => void open(d)} className="flex items-center gap-3 rounded-[14px] border border-line bg-raised px-4 py-3 text-left hover:border-ice-line">
                  <DeviceBadge device={d.kind} model={d.model} />
                  <span className="font-mono text-[12px] text-mute">{d.id}</span>
                </button>
              ))}
            </div>
          )}
          {error !== null && <HwErrorNotice error={error} />}
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void detect()} disabled={busy !== null}>
              <IconRefresh size={14} /> {devices ? 'Relancer la détection' : 'Détecter'}
            </Button>
            {onCancel && <Button onClick={onCancel}>Annuler</Button>}
          </div>
        </div>
      )}

      {step === 'device' && device && (
        <div className="flex flex-col gap-3.5">
          <div className="flex items-center gap-3">
            <DeviceBadge device={device.kind} model={device.model} />
            {status?.app && <span className="text-[12px] text-mute">App ouverte : {status.app.name}{status.app.version ? ` ${status.app.version}` : ''}</span>}
            {status?.firmware && <span className="text-[12px] text-mute">Firmware {status.firmware}</span>}
          </div>
          {busy === 'open' && <HwWaiting deviceId={device.id} idle="Lecture de l’état de l’appareil…" />}
          {status && (
            <>
              {status.locked && (
                <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
                  <strong className="font-semibold">Déverrouille ton appareil</strong> avec ton code PIN{device.kind === 'trezor' ? ' (sur l’appareil, ou dans la grille pour une Trezor One)' : ''}, puis clique sur « Actualiser ».
                </Notice>
              )}
              {status.passphrase && device.model === 'Trezor One' && (
                <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
                  Passphrase activée : sur la Trezor One elle se taperait sur l’ordinateur, ce que Kyro refuse (aucun secret ne doit passer par l’interface). Désactive-la sur l’appareil pour l’utiliser avec Kyro.
                </Notice>
              )}
              <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Chaînes">
                {IMPLEMENTED.map((c) => (
                  <ChainRow key={c} st={status.chains.find((x) => x.chain === c)} chain={c} checked={chains.has(c)} onToggle={(on) => setChains((s) => { const n = new Set(s); if (on) n.add(c); else n.delete(c); return n; })} />
                ))}
              </ul>
              <span className="text-[12px] text-faint">Litecoin, Dogecoin et TRON : pas encore sur hardware wallet (disponibles dans le coffre Kyro). Cardano, XRP : pas encore pris en charge par Kyro.</span>
              <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-2.5">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-mute">N° de compte</span>
                  <Input value={account} inputMode="numeric" onChange={(e) => setAccount(e.target.value.replace(/\D/g, '').slice(0, 3))} className="font-mono" />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium text-mute">Nom (facultatif)</span>
                  <Input value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} placeholder={`${device.model} ${(accountValid ? accountNumber : 0) + 1}`} />
                </label>
              </div>
              {!accountValid && <span className="text-[12px] text-down">Numéro de compte : 0 à {MAX_HW_ACCOUNT}.</span>}
              <span className="text-[12px] leading-[1.5] text-faint">Compte 0 = le premier compte de ton appareil (le même que dans Ledger Live ou Trezor Suite).</span>
            </>
          )}
          {error !== null && <HwErrorNotice error={error} onRetry={() => void open(device)} />}
          <div className="flex gap-2">
            <Button variant="primary" disabled={!status || busy !== null || chains.size === 0 || !accountValid} onClick={() => void read()}>
              Lire les clés publiques
            </Button>
            <Button onClick={() => void open(device)} disabled={busy !== null}>
              <IconRefresh size={14} /> Actualiser
            </Button>
            <Button variant="ghost" onClick={() => { setStep('detect'); setStatus(null); setError(null); }} disabled={busy !== null}>
              Autre appareil
            </Button>
          </div>
        </div>
      )}

      {step === 'reading' && device && (
        <div className="flex flex-col gap-3">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {IMPLEMENTED.filter((c) => chains.has(c)).map((c) => {
              const st = progress[c];
              const app = status?.chains.find((x) => x.chain === c)?.app;
              return (
                <li key={c} className="flex items-center gap-3 rounded-[12px] border border-line bg-raised px-4 py-2.5">
                  {st === 'ok' ? <IconCheck size={15} className="text-up" /> : st === 'reading' ? <Spinner className="size-3.5 text-ice" /> : st === 'error' ? <IconX size={15} className="text-down" /> : <span className="size-1.5 rounded-full bg-faint" />}
                  <span className="flex-1 text-[13px] font-semibold">{CHAIN_LABEL[c]}</span>
                  {device.kind === 'ledger' && app && <span className="text-[12px] text-mute">app « {app} »</span>}
                </li>
              );
            })}
          </ul>
          {busy && busy !== 'open' && <HwWaiting deviceId={device.id} idle={device.kind === 'ledger' ? `Lecture des clés ${CHAIN_LABEL[busy as HwImplementedChain] ?? ''} : garde l’app ouverte sur le Ledger…` : 'Lecture des clés publiques…'} />}
          {failed && (
            <>
              <HwErrorNotice error={failed.error} />
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => void read(failed.chain)}>
                  <IconRefresh size={14} /> Réessayer {CHAIN_LABEL[failed.chain]}
                </Button>
                <Button onClick={() => { setStep('device'); setError(null); }}>Retour</Button>
              </div>
            </>
          )}
        </div>
      )}

      {step === 'done' && saved && <HwAccountSummary acc={saved} action={<Button variant="primary" onClick={() => onDone(saved)}>Utiliser ce compte</Button>} />}
    </div>
  );
}

function ChainRow({ st, chain, checked, onToggle }: { st: HwChainStatus | undefined; chain: HwImplementedChain; checked: boolean; onToggle: (on: boolean) => void }) {
  const unsupported = st?.state === 'unsupported';
  const hint =
    !st
      ? null
      : st.state === 'ready'
        ? 'Prêt'
        : st.state === 'open-app'
          ? `Ouvre l’app « ${st.app ?? ''} »${st.min ? ` (version ${st.min} minimum)` : ''} sur l’appareil`
          : st.state === 'unlock'
            ? 'Déverrouille ton appareil'
            : // Rust reasons start with the chain name, already shown on the row.
              `${(st.reason ?? 'Non pris en charge').replace(/^(Bitcoin|EVM|Ethereum|Solana)\s*:\s*/, '')}${st.min ? ` (minimum ${st.min})` : ''}`;
  return (
    <li>
      <label className={cn('flex items-center gap-3 rounded-[12px] border px-4 py-2.5', unsupported ? 'border-line bg-card opacity-60' : 'cursor-pointer border-line bg-raised hover:border-line-3')}>
        <input type="checkbox" checked={checked && !unsupported} disabled={unsupported} onChange={(e) => onToggle(e.target.checked)} className="size-4 accent-[#7cc4ff]" />
        <span className="flex-1 text-[13px] font-semibold">{CHAIN_LABEL[chain]}</span>
        <span className={cn('text-[12px]', st?.state === 'ready' ? 'text-up' : st?.state === 'unsupported' ? 'text-faint' : 'text-warn')}>{hint}</span>
      </label>
    </li>
  );
}

/** Model, fingerprint, chains and first addresses of a hardware-wallet account. */
export function HwAccountSummary({ acc, action }: { acc: WatchOnlyAccount; action?: ReactNode }) {
  const view = (() => {
    try {
      return hwToAccounts(acc);
    } catch {
      return null;
    }
  })();
  const fp = hwFingerprint(acc);
  return (
    <div className="flex flex-col gap-3 rounded-[16px] border border-line bg-raised px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-[15px] font-semibold">{acc.label}</span>
          <span className="text-[12px] text-mute">
            Compte n° {acc.account} · {acc.network === 'testnet' ? 'testnet' : 'mainnet'}
          </span>
        </span>
        <DeviceBadge device={acc.device} model={acc.model} />
      </div>
      <dl className="m-0 grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12px]">
        <dt className="text-mute">Empreinte du compte</dt>
        <dd className="m-0 font-mono text-text">{fp ?? '— (pas de clés Bitcoin)'}</dd>
        {view?.btc && (
          <>
            <dt className="text-mute">Bitcoin</dt>
            <dd className="m-0 font-mono text-text2">{shortAddress(view.btc.segwit.address)} · {shortAddress(view.btc.taproot.address)}</dd>
          </>
        )}
        {view?.evm && (
          <>
            <dt className="text-mute">EVM</dt>
            <dd className="m-0 font-mono text-text2">{shortAddress(view.evm.address)}</dd>
          </>
        )}
        {view?.sol && (
          <>
            <dt className="text-mute">Solana</dt>
            <dd className="m-0 font-mono text-text2">{shortAddress(view.sol.address)}</dd>
          </>
        )}
      </dl>
      <span className="text-[12px] leading-[1.5] text-faint">Clés publiques seulement. Vérifie toujours une adresse de réception sur l’écran de l’appareil avant de la communiquer.</span>
      {action && <div>{action}</div>}
    </div>
  );
}
