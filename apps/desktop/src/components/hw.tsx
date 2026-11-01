// SPDX-License-Identifier: GPL-3.0-or-later
//
// Hardware wallets (Ledger, Trezor): device badge, waiting state with Cancel, error notice,
// the full-screen stop for HW_ADDRESS_MISMATCH, the Trezor One blind PIN matrix (global), and
// the add-device flow (Welcome and Settings › Devices). Contract: docs/IPC.md §2.3.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { call, errorData, ipcErrorIn, isDemoMode, MAX_HW_ACCOUNT, type HwChain, type HwChainStatus, type HwDeviceInfo, type HwDeviceKind, type HwDeviceStatus, type HwImplementedChain, type WatchOnlyAccount } from '@kyro/shared';
import { hwFingerprint, hwToAccounts } from '@kyro/chains';
import { BRAND, hwErrorView, hwPromptStore, pinPosition, useHwPrompts, withDevice, PIN_MATRIX_KEYPAD } from '../state/hw';
import { cn } from '../lib/cn';
import { shortAddress } from '../lib/format';
import { useApp } from '../state/app';
import { Dialog } from './ui/dialog';
import { Badge, Button, Input, Notice, Spinner } from './ui/primitives';
import { IconCheck, IconInfo, IconPhoneKey, IconRefresh, IconUsbKey, IconWarn, IconX } from './icons';
import { t, useT, type Key } from '../i18n';
import { rt } from '../i18n/rich';

// ---------------------------------------------------------------- small pieces

export function DeviceBadge({ device, model, className }: { device: HwDeviceKind; model?: string; className?: string }) {
  return (
    <Badge tone="ice" className={cn('gap-1', className)}>
      {device === 'ledger' ? <IconUsbKey size={11} /> : <IconPhoneKey size={11} />}
      {model ?? BRAND[device]}
    </Badge>
  );
}

const PROMPT_KEYS: Record<string, { title: Key; detail: Key }> = {
  'confirm-on-device': { title: 'hw.prompt.confirmTitle', detail: 'hw.prompt.confirmDetail' },
  'pin-on-device': { title: 'hw.prompt.pinTitle', detail: 'hw.prompt.pinDetail' },
  'passphrase-on-device': { title: 'hw.prompt.passphraseTitle', detail: 'hw.prompt.passphraseDetail' },
  'pin-matrix': { title: 'hw.prompt.matrixTitle', detail: 'hw.prompt.matrixDetail' },
  'thp-confirm-pairing': { title: 'hw.prompt.thpPairingTitle', detail: 'hw.prompt.thpPairingDetail' },
  'thp-pairing-code': { title: 'hw.prompt.thpCodeTitle', detail: 'hw.prompt.thpCodeDetail' },
  'thp-confirm-connection': { title: 'hw.prompt.thpConnectionTitle', detail: 'hw.prompt.thpConnectionDetail' },
};

/** Title and detail of a device prompt, in the current language. */
function promptText(kind: string): { title: string; detail: string } | null {
  const k = PROMPT_KEYS[kind];
  return k ? { title: t(k.title as 'hw.prompt.confirmTitle'), detail: t(k.detail as 'hw.prompt.confirmDetail') } : null;
}

/** "Waiting for the device" panel with Cancel (`hw_cancel`). */
export function HwWaiting({ deviceId, idle, className, confirm }: { deviceId: string; idle?: string; className?: string; confirm?: { title: string; detail: string } }) {
  const prompt = useHwPrompts().byDevice[deviceId];
  const [cancelling, setCancelling] = useState(false);
  const { t } = useT();
  const text = prompt === 'confirm-on-device' && confirm ? confirm : prompt ? promptText(prompt) : null;
  return (
    <div role="status" aria-live="polite" className={cn('fade-in flex items-start gap-3.5 rounded-box border border-l-2 border-ice-line border-l-ice bg-ice/[.05] px-4 py-3.5', className)}>
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-ctl bg-ice/12 text-ice">
        <Spinner className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-semibold text-text">{text?.title ?? idle ?? t('hw.waiting.title')}</span>
        <span className="text-[12px] leading-[1.5] text-mute">{text?.detail ?? t('hw.waiting.detail')}</span>
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
        {cancelling && <Spinner />} {t('common.cancel')}
      </Button>
    </div>
  );
}

export function HwErrorNotice({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const { t } = useT();
  const v = hwErrorView(error);
  const { navigate } = useApp();
  // Safe 7 not paired (any command but hw_open): the way out is « Connecter ».
  const pairing = ipcErrorIn(error)?.code === 'HW_PAIRING_REQUIRED';
  return (
    <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />} {...(className ? { className } : {})}>
      <span className="block font-semibold">{v.title}</span>
      <span className="block">{v.detail}</span>
      {pairing ? (
        <button type="button" onClick={() => navigate({ name: 'settings', section: 'hardware' })} className="mt-1.5 font-semibold text-ice hover:underline">
          {t('hw.connect')}
        </button>
      ) : (
        onRetry && (
          <button type="button" onClick={onRetry} className="mt-1.5 font-semibold text-ice hover:underline">
            {t('common.retry')}
          </button>
        )
      )}
    </Notice>
  );
}

/** HW_ADDRESS_MISMATCH: a full-screen red stop. The address must not be used. */
export function AddressMismatchStop({ error, onClose }: { error: unknown; onClose: () => void }) {
  const d = errorData(error, 'HW_ADDRESS_MISMATCH');
  const { t } = useT();
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="mismatch-title" className="fixed inset-0 z-[60] flex items-center justify-center bg-[#2a0707]/95 p-8 backdrop-blur-[2px]">
      <div className="dialog flex max-w-[640px] flex-col gap-5 rounded-panel border-2 border-down bg-[#1a0a0a] p-8" data-state="open">
        <span className="flex size-14 items-center justify-center rounded-full bg-down/20 text-down">
          <IconWarn size={28} />
        </span>
        <h1 id="mismatch-title" className="m-0 text-[30px] leading-[1.15] font-semibold tracking-[-0.03em] text-[#ffd6d6]">
          {t('hw.mismatch.title')}
        </h1>
        <p className="m-0 text-[15px] leading-[1.6] text-[#ffc2c2]">
          {t('hw.mismatch.body')}
        </p>
        {d && (
          <dl className="m-0 flex flex-col gap-2 rounded-box border border-down/40 bg-black/30 p-4 font-mono text-[12px]">
            <div className="flex flex-col gap-0.5">
              <dt className="font-sans text-[12px] text-[#ff9a9a]">{t('hw.mismatch.device')}</dt>
              <dd className="m-0 break-all text-[#ffd6d6]">{d.device}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="font-sans text-[12px] text-[#ff9a9a]">{t('hw.mismatch.expected')}</dt>
              <dd className="m-0 break-all text-[#ffd6d6]">{d.expected}</dd>
            </div>
          </dl>
        )}
        <p className="m-0 text-[13px] leading-[1.55] text-[#ff9a9a]">{t('hw.mismatch.advice')}</p>
        <div>
          <Button variant="danger" onClick={onClose}>
            {t('hw.mismatch.ack')}
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
  const thp = Object.entries(byDevice).find(([, k]) => k === 'thp-pairing-code')?.[0] ?? null;
  return (
    <>
      <PinMatrixDialog deviceId={id} />
      <ThpCodeDialog deviceId={thp} />
    </>
  );
}

/**
 * Trezor Safe 7 pairing (THP): the device shows a 6-digit code, the user types it here
 * (`hw_thp_pairing_code`). A malformed code (INVALID_INPUT) keeps this open; a wrong one makes
 * hw_open fail with HW_PAIRING_FAILED (shown where hw_open was called, with « Réessayer »).
 */
export function ThpCodeDialog({ deviceId }: { deviceId: string | null }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const { t } = useT();
  useEffect(() => {
    setCode('');
    setError(null);
    setDemoCode(null);
    if (!deviceId || !isDemoMode()) return;
    void import('@kyro/shared/mock').then((m) => setDemoCode(m.demoThpCode()));
  }, [deviceId]);
  if (!deviceId) return null;
  const valid = /^[0-9]{6}$/.test(code);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('hw_thp_pairing_code', { id: deviceId, code });
      hwPromptStore.clear(deviceId);
    } catch (e) {
      // INVALID_INPUT: hw_open keeps waiting, the entry stays open.
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : void call('hw_cancel', { id: deviceId }).catch(() => undefined))} title={t('hw.thp.title')} className="w-[440px]">
      <p className="m-0 text-[13px] leading-[1.55] text-text2">{rt('hw.thp.body', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}</p>
      <input
        autoFocus
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label={t('hw.thp.inputLabel')}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && valid && !busy) void submit();
        }}
        placeholder="••••••"
        className="h-14 rounded-ctl border border-line-3 bg-bg text-center font-mono text-[28px] font-semibold tracking-[0.5em] text-text focus:border-ice-line"
      />
      {demoCode && <span className="text-[12px] text-ice-text2">{t('hw.thp.demo', { code: demoCode })}</span>}
      {error !== null && <HwErrorNotice error={error} />}
      <div className="flex justify-end gap-2">
        <Button onClick={() => void call('hw_cancel', { id: deviceId }).catch(() => undefined)} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={!valid || busy}>
          {busy && <Spinner />} {t('hw.validate')}
        </Button>
      </div>
    </Dialog>
  );
}

export function PinMatrixDialog({ deviceId }: { deviceId: string | null }) {
  const [positions, setPositions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [demoLayout, setDemoLayout] = useState<number[][] | null>(null);
  const { t, tp } = useT();
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
    <Dialog open onOpenChange={(v) => (v ? undefined : void call('hw_cancel', { id: deviceId }).catch(() => undefined))} title={t('hw.pin.title')} className="w-[440px]">
      <p className="m-0 text-[13px] leading-[1.55] text-text2">{rt('hw.pin.body', { b: (c) => <strong className="font-semibold text-text">{c}</strong> })}</p>
      <div className="flex items-start justify-center gap-6">
        <div role="group" aria-label={t('hw.pin.gridLabel')} className="grid grid-cols-3 gap-2">
          {PIN_MATRIX_KEYPAD.map((row, r) =>
            row.map((_, c) => (
              <button
                key={`${r}-${c}`}
                type="button"
                aria-label={t('hw.pin.cellLabel', { row: r + 1, col: c + 1 })}
                disabled={busy || positions.length >= 9}
                onClick={() => setPositions((p) => p + pinPosition(r, c))}
                className="flex size-16 items-center justify-center rounded-box border border-line-2 bg-bg text-[22px] text-faint hover:border-ice-line hover:bg-control"
              >
                •
              </button>
            )),
          )}
        </div>
        {demoLayout && (
          <div className="flex flex-col items-center gap-1.5" aria-label={t('hw.pin.simulatedScreen')}>
            <span className="text-[11px] font-semibold tracking-[0.04em] text-ice uppercase">{t('hw.pin.demoMode')}</span>
            <div className="grid grid-cols-3 gap-1 rounded-ctl border border-line bg-black p-2 font-mono text-[14px] text-text">
              {demoLayout.flat().map((n, i) => (
                <span key={i} className="flex size-7 items-center justify-center">
                  {n}
                </span>
              ))}
            </div>
            <span className="max-w-[120px] text-center text-[11px] text-faint">{t('hw.pin.demoHint')}</span>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between">
        <span aria-label={tp('hw.pin.entered', positions.length)} className="font-mono text-[18px] tracking-[0.3em] text-text">
          {positions.length ? '•'.repeat(positions.length) : <span className="text-[12px] tracking-normal text-faint">{t('hw.pin.none')}</span>}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setPositions((p) => p.slice(0, -1))} disabled={!positions || busy}>
          {t('hw.pin.erase')}
        </Button>
      </div>
      {error !== null && <HwErrorNotice error={error} />}
      <p className="m-0 flex items-start gap-2 text-[12px] leading-[1.5] text-mute">
        <IconInfo size={14} className="mt-0.5 shrink-0 text-faint" />
        {t('hw.pin.passphraseNote')}
      </p>
      <div className="flex justify-end gap-2">
        <Button onClick={() => void call('hw_cancel', { id: deviceId }).catch(() => undefined)} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={positions.length < 1 || busy}>
          {busy && <Spinner />} {t('hw.validate')}
        </Button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- add a device

const CHAIN_NAME: Record<Exclude<HwChain, 'evm'>, string> = { btc: 'Bitcoin', sol: 'Solana', ltc: 'Litecoin', doge: 'Dogecoin', tron: 'TRON', cardano: 'Cardano', xrp: 'XRP', xmr: 'Monero' };
/** Chain name shown in the add-device flow (« Ethereum et EVM » is translated). */
const chainLabel = (c: HwChain): string => (c === 'evm' ? t('hw.chain.evm') : CHAIN_NAME[c]);
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
  const { t } = useT();

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
      <ol className="m-0 flex list-none gap-2 p-0 text-[12px]" aria-label={t('hw.steps')}>
        {[t('hw.step.detect'), t('hw.step.open'), t('hw.step.read'), t('hw.step.done')].map((s, i) => {
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
          <p className="m-0 text-[14px] leading-[1.55] text-text2">{t('hw.setup.intro')}</p>
          {busy === 'detect' && (
            <span className="flex items-center gap-2 text-[13px] text-mute">
              <Spinner /> {t('hw.setup.searching')}
            </span>
          )}
          {devices && devices.length === 0 && busy !== 'detect' && (
            <Notice icon={<IconInfo size={16} className="mt-0.5 shrink-0 text-ice" />}>
              <span className="block font-semibold text-text">{t('hw.setup.noneTitle')}</span>
              <span className="block">{t('hw.setup.noneDetail')}</span>
            </Notice>
          )}
          {devices && devices.length > 1 && (
            <div className="flex flex-col gap-2">
              {devices.map((d) => (
                <button key={d.id} type="button" onClick={() => void open(d)} className="flex items-center gap-3 rounded-box border border-line bg-raised px-4 py-3 text-left hover:border-ice-line">
                  <DeviceBadge device={d.kind} model={d.model} />
                  <span className="font-mono text-[12px] text-mute">{d.id}</span>
                </button>
              ))}
            </div>
          )}
          {error !== null && <HwErrorNotice error={error} />}
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void detect()} disabled={busy !== null}>
              <IconRefresh size={14} /> {devices ? t('hw.setup.redetect') : t('hw.setup.detect')}
            </Button>
            {onCancel && <Button onClick={onCancel}>{t('common.cancel')}</Button>}
          </div>
        </div>
      )}

      {step === 'device' && device && (
        <div className="flex flex-col gap-3.5">
          <div className="flex items-center gap-3">
            <DeviceBadge device={device.kind} model={status?.model ?? device.model} />
            {status?.app && <span className="text-[12px] text-mute">{t('hw.setup.appOpen', { app: `${status.app.name}${status.app.version ? ` ${status.app.version}` : ''}` })}</span>}
            {status?.firmware && <span className="text-[12px] text-mute">{t('hw.setup.firmware', { version: status.firmware })}</span>}
            {status?.protocol === 'thp' && <Badge tone="up">{t('hw.setup.thpChannel')}</Badge>}
          </div>
          {busy === 'open' && <HwWaiting deviceId={device.id} idle={t('hw.setup.readingState')} />}
          {status && (
            <>
              {status.locked && (
                <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
                  {rt(device.kind === 'trezor' ? 'hw.setup.unlockTrezor' : 'hw.setup.unlock', { b: (c) => <strong className="font-semibold">{c}</strong> })}
                </Notice>
              )}
              {status.passphrase && device.model === 'Trezor One' && (
                <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
                  {t('hw.setup.passphraseOne')}
                </Notice>
              )}
              <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={t('hw.setup.chains')}>
                {IMPLEMENTED.map((c) => (
                  <ChainRow key={c} st={status.chains.find((x) => x.chain === c)} chain={c} checked={chains.has(c)} onToggle={(on) => setChains((s) => { const n = new Set(s); if (on) n.add(c); else n.delete(c); return n; })} />
                ))}
              </ul>
              <span className="text-[12px] text-faint">{t('hw.setup.notYet')}</span>
              <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-2.5">
                <label className="flex flex-col gap-1.5">
                  <span className="eyebrow">{t('hw.setup.accountNumber')}</span>
                  <Input value={account} inputMode="numeric" onChange={(e) => setAccount(e.target.value.replace(/\D/g, '').slice(0, 3))} className="font-mono" />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="eyebrow">{t('hw.setup.nameOptional')}</span>
                  <Input value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} placeholder={`${device.model} ${(accountValid ? accountNumber : 0) + 1}`} />
                </label>
              </div>
              {!accountValid && <span className="text-[12px] text-down">{t('hw.setup.accountRange', { max: MAX_HW_ACCOUNT })}</span>}
              <span className="text-[12px] leading-[1.5] text-faint">{t('hw.setup.accountHint')}</span>
            </>
          )}
          {error !== null && <HwErrorNotice error={error} onRetry={() => void open(device)} />}
          <div className="flex gap-2">
            <Button variant="primary" disabled={!status || busy !== null || chains.size === 0 || !accountValid} onClick={() => void read()}>
              {t('hw.setup.readKeys')}
            </Button>
            <Button onClick={() => void open(device)} disabled={busy !== null}>
              <IconRefresh size={14} /> {t('hw.setup.refresh')}
            </Button>
            <Button variant="ghost" onClick={() => { setStep('detect'); setStatus(null); setError(null); }} disabled={busy !== null}>
              {t('hw.setup.otherDevice')}
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
                <li key={c} className="flex items-center gap-3 rounded-ctl border border-line bg-raised px-4 py-2.5">
                  {st === 'ok' ? <IconCheck size={15} className="text-up" /> : st === 'reading' ? <Spinner className="size-3.5 text-ice" /> : st === 'error' ? <IconX size={15} className="text-down" /> : <span className="size-1.5 rounded-full bg-faint" />}
                  <span className="flex-1 text-[13px] font-semibold">{chainLabel(c)}</span>
                  {device.kind === 'ledger' && app && <span className="text-[12px] text-mute">{t('hw.setup.ledgerApp', { app })}</span>}
                </li>
              );
            })}
          </ul>
          {busy && busy !== 'open' && <HwWaiting deviceId={device.id} idle={device.kind === 'ledger' ? t('hw.setup.readingLedger', { chain: IMPLEMENTED.includes(busy as HwImplementedChain) ? chainLabel(busy as HwImplementedChain) : '' }) : t('hw.setup.readingKeys')} />}
          {failed && (
            <>
              <HwErrorNotice error={failed.error} />
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => void read(failed.chain)}>
                  <IconRefresh size={14} /> {t('hw.setup.retryChain', { chain: chainLabel(failed.chain) })}
                </Button>
                <Button onClick={() => { setStep('device'); setError(null); }}>{t('common.back')}</Button>
              </div>
            </>
          )}
        </div>
      )}

      {step === 'done' && saved && <HwAccountSummary acc={saved} action={<Button variant="primary" onClick={() => onDone(saved)}>{t('hw.setup.useAccount')}</Button>} />}
    </div>
  );
}

function ChainRow({ st, chain, checked, onToggle }: { st: HwChainStatus | undefined; chain: HwImplementedChain; checked: boolean; onToggle: (on: boolean) => void }) {
  const { t } = useT();
  const unsupported = st?.state === 'unsupported';
  const reason = (st?.reason ?? t('hw.chainRow.unsupported')).replace(/^(Bitcoin|EVM|Ethereum|Solana)\s*:\s*/, '');
  const hint =
    !st
      ? null
      : st.state === 'ready'
        ? t('hw.chainRow.ready')
        : st.state === 'open-app'
          ? st.min
            ? t('hw.chainRow.openAppMin', { app: st.app ?? '', min: st.min })
            : t('hw.chainRow.openApp', { app: st.app ?? '' })
          : st.state === 'unlock'
            ? t('hw.chainRow.unlock')
            : // Rust reasons start with the chain name, already shown on the row.
              st.min
              ? t('hw.chainRow.min', { reason, min: st.min })
              : reason;
  return (
    <li>
      <label className={cn('flex items-center gap-3 rounded-ctl border px-4 py-2.5', unsupported ? 'border-line bg-card opacity-60' : 'cursor-pointer border-line bg-raised hover:border-line-3')}>
        <input type="checkbox" checked={checked && !unsupported} disabled={unsupported} onChange={(e) => onToggle(e.target.checked)} className="size-4 accent-[#7cc4ff]" />
        <span className="flex-1 text-[13px] font-semibold">{chainLabel(chain)}</span>
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
  const { t } = useT();
  return (
    <div className="flex flex-col gap-3 rounded-box border border-line bg-raised px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-[15px] font-medium tracking-[-0.01em]">{acc.label}</span>
          <span className="text-[12px] text-mute">
            {t('hw.summary.account', { n: acc.account, network: acc.network === 'testnet' ? 'testnet' : 'mainnet' })}
          </span>
        </span>
        <DeviceBadge device={acc.device} model={acc.model} />
      </div>
      <dl className="m-0 grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12px]">
        <dt className="text-mute">{t('hw.summary.fingerprint')}</dt>
        <dd className="m-0 font-mono text-text">{fp ?? t('hw.summary.noBtc')}</dd>
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
      <span className="text-[12px] leading-[1.5] text-faint">{t('hw.summary.note')}</span>
      {action && <div>{action}</div>}
    </div>
  );
}
