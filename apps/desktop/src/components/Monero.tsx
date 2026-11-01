// SPDX-License-Identifier: GPL-3.0-or-later
// Monero pieces of the app (docs/IPC.md §2.11): - the scan status: Rust downloads the blocks and
// scans them on this machine (no key sent to the node), in a background task started here and
// polled while it runs; - Receive: primary address + subaddresses handed out one by one
// (recommended: one per payer); - Send: Rust's decoding of the destination, then of the built
// transfer, before the password; - Réglages › Sécurité: the 25-word Monero seed (native window
// only) and the restore height.

import { useEffect, useRef, useState } from 'react';
import { toIpcError, type Currency } from '@kyro/shared';
import { xmrDestinationLabel, xmrHeightAt, XMR_DECIMALS, XMR_LOCK_BLOCKS, type XmrAdapter, type XmrDestination, type XmrStatus, type XmrSubaddress, type XmrUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, fmtNumber } from '../lib/format';
import { cn } from '../lib/cn';
import { AddressBlocks, CopyButton, PasswordField } from './kit';
import { Dialog } from './ui/dialog';
import { Button, Input, Notice, Spinner } from './ui/primitives';
import { IconInfo, IconWarn } from './icons';
import { locale, t, tp, useT, type Key } from '../i18n';
import { rt } from '../i18n/rich';

const XMR = (pico: bigint | string) => fmtCrypto(BigInt(pico), XMR_DECIMALS, 'XMR', 6);
const fmtDate = (unixSecs: number) => new Date(unixSecs * 1000).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });

const WARNINGS: Record<XmrUnsigned['summary']['warnings'][number], Key> = {
  integratedAddress: 'xmr.wIntegratedAddress',
  highFee: 'xmr.wHighFee',
  feeAboveAmount: 'xmr.wFeeAboveAmount',
  ownAddress: 'xmr.wOwnAddress',
};

/** Scan status of the active Monero account. */
export function useXmrStatus(adapter: XmrAdapter | null | undefined): { status: XmrStatus | null; error: string | null; sync: () => void; reload: () => void } {
  const [status, setStatus] = useState<XmrStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const started = useRef<XmrAdapter | null>(null);
  const running = status?.running ?? false;

  useEffect(() => {
    if (!adapter) return;
    let alive = true;
    const first = started.current !== adapter;
    started.current = adapter;
    (first ? adapter.sync() : adapter.status())
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(toIpcError(e).message));
    return () => {
      alive = false;
    };
  }, [adapter, tick]);

  useEffect(() => {
    if (!adapter) return;
    const id = window.setInterval(() => setTick((t) => t + 1), running ? 2_000 : 60_000);
    return () => window.clearInterval(id);
  }, [adapter, running]);

  return {
    status,
    error,
    sync: () => {
      if (!adapter) return;
      adapter
        .sync()
        .then((s) => setStatus(s))
        .catch((e: unknown) => setError(toIpcError(e).message));
    },
    reload: () => setTick((t) => t + 1),
  };
}

/** Progress of the scan, or what was scanned and when. */
export function XmrSyncLine({ status, error, onRetry, className }: { status: XmrStatus | null; error: string | null; onRetry?: () => void; className?: string }) {
  useT();
  if (error && !status) {
    return (
      <span className={cn('flex items-center gap-2 text-[12px] text-down', className)}>
        {t('xmr.errorLine', { error })}
        {onRetry && (
          <button type="button" className="underline" onClick={onRetry}>
            {t('common.retry')}
          </button>
        )}
      </span>
    );
  }
  if (!status) {
    return (
      <span className={cn('flex items-center gap-2 text-[12px] text-mute', className)}>
        <Spinner /> {t('xmr.readingStatus')}
      </span>
    );
  }
  const pct = Math.round(status.progress * 100);
  const done = !status.running && status.restoreHeight !== null && status.progress >= 1;
  return (
    <div className={cn('flex flex-col gap-1.5 text-[12px]', className)} aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-text2">
          {status.running && <Spinner />}
          {status.running ? t('xmr.scanning', { pct }) : done ? t('xmr.upToDate') : status.restoreHeight === null ? t('xmr.notStarted') : t('xmr.interrupted', { pct })}
        </span>
        <span className="font-mono text-[11px] text-mute">
          {status.tip !== null ? t('xmr.blockProgress', { scanned: fmtNumber(status.scanned, 0), tip: fmtNumber(status.tip, 0) }) : ''}
        </span>
      </div>
      {(status.running || !done) && status.restoreHeight !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t('xmr.progressLabel')}>
          <div className="h-full bg-ice transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}
      {status.error && (
        <span className="flex items-center gap-2 text-down">
          {status.error}
          {onRetry && !status.running && (
            <button type="button" className="underline" onClick={onRetry}>
              {t('xmr.restart')}
            </button>
          )}
        </span>
      )}
      {!status.running && !status.error && onRetry && done && (
        <span className="text-mute">
          {t('xmr.nodeInfo', { node: status.node || '—' })}{' '}
          <button type="button" className="underline" onClick={onRetry}>
            {t('xmr.refresh')}
          </button>
        </span>
      )}
      {status.ignoredOutputs > 0 && <span className="text-warn">{tp('xmr.ignored', status.ignoredOutputs)}</span>}
    </div>
  );
}

/** « dont X XMR bloqués » under a Monero balance. */
export function XmrLockedNote({ status, hidden }: { status: XmrStatus | null; hidden: boolean }) {
  useT();
  if (!status) return null;
  const locked = BigInt(status.balance) - BigInt(status.unlocked);
  if (locked <= 0n) return null;
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      {rt('xmr.locked', { b: (c) => <strong className="font-semibold text-text2">{c}</strong> }, { locked: hidden ? '•••••' : XMR(locked), blocks: XMR_LOCK_BLOCKS, unlocked: hidden ? '•••••' : XMR(status.unlocked) })}
    </span>
  );
}

/** Rust's decoding of the typed destination. */
export function XmrDestinationLine({ dest, error, loading }: { dest: XmrDestination | undefined; error: string | null; loading: boolean }) {
  useT();
  if (loading && !dest) {
    return (
      <span className="flex items-center gap-2 text-[12px] text-mute">
        <Spinner /> {t('xmr.checkingAddress')}
      </span>
    );
  }
  if (error) return <span className="text-[12px] text-down">{error}</span>;
  if (!dest) return null;
  return (
    <span className={cn('flex items-start gap-1.5 text-[12px] leading-[1.45]', dest.kind === 'integrated' ? 'text-warn' : 'text-mute')}>
      <IconInfo size={13} className="mt-0.5 shrink-0" />
      <span>
        <strong className="font-semibold text-text2">{xmrDestinationLabel(dest)}</strong>
        {dest.kind === 'integrated' ? t('xmr.integratedHint') : t('xmr.decodedHint')}
      </span>
    </span>
  );
}

/** The transfer as Rust built it, before the password. */
export function XmrSummaryView({ u, xmrPrice, currency }: { u: XmrUnsigned; xmrPrice: number | null; currency: Currency }) {
  useT();
  const s = u.summary;
  const fiat = (p: string) => {
    const v = xmrPrice !== null ? (Number(BigInt(p)) / 1e12) * xmrPrice : 0;
    return v >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label={t('xmr.builtLabel')}>
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">{t('xmr.title')}</span>
        <span className="text-[11px] text-mute">{t('xmr.builtByVault')}</span>
      </div>
      <Line k={t('xmr.lDest')} v={xmrDestinationLabel(s.destination)} warn={s.destination.kind === 'integrated'} />
      <Line k={t('xmr.lAmount')} v={`${XMR(s.amount)}${fiat(s.amount)}`} />
      <Line k={t('xmr.lFee')} v={`${XMR(s.fee)}${fiat(s.fee)}`} />
      <Line k={t('xmr.lChange')} v={XMR(s.change)} />
      <Line k={t('xmr.lSpent')} v={tp('xmr.lSpentValue', s.inputCount, { amount: XMR(s.inputsTotal) })} />
      <Line k={t('xmr.lRings')} v={t('xmr.lRingsValue', { size: s.ringSize, decoys: s.ringSize - 1 })} last />
      {s.requiresExtraConfirmation && (
        <div className="border-t border-line px-3.5 py-2 text-warn">
          {t('xmr.extraConfirm', { list: s.warnings.map((w) => (t as (k: Key) => string)(WARNINGS[w])).join(', ') })}
        </div>
      )}
    </div>
  );
}

function Line({ k, v, warn, last }: { k: string; v: string; warn?: boolean; last?: boolean }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-3.5 py-1.5', !last && 'border-b border-line')}>
      <span className="text-text2">{k}</span>
      <span className={cn('text-right', warn ? 'text-warn' : 'text-text2')}>{v}</span>
    </div>
  );
}

/** Notes shown on the Send screen for Monero. */
export function XmrSendNotes() {
  useT();
  return (
    <span className="flex items-start gap-1.5 text-[12px] leading-[1.5] text-mute">
      <IconWarn size={13} className="mt-0.5 shrink-0 text-warn" />
      <span>
        {t('xmr.sendNotes', { blocks: XMR_LOCK_BLOCKS })}
      </span>
    </span>
  );
}

/** Receive: subaddresses handed out by Rust, with what each received. */
export function XmrReceivePanel({ adapter, hidden }: { adapter: XmrAdapter; hidden: boolean }) {
  useT();
  const [list, setList] = useState<XmrSubaddress[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { status, error: statusError, sync } = useXmrStatus(adapter);
  useEffect(() => {
    let alive = true;
    adapter.backend
      .subaddresses()
      .then((l) => alive && setList(l))
      .catch((e: unknown) => alive && setError(toIpcError(e).message));
    return () => {
      alive = false;
    };
  }, [adapter]);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await adapter.backend.newSubaddress();
      setList((l) => [...(l ?? []), s]);
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };
  const subs = (list ?? []).filter((s) => s.index > 0);
  return (
    <div className="flex flex-col gap-3">
      <XmrSyncLine status={status} error={statusError} onRetry={sync} />
      {status && status.restoreHeight !== null && (
        <span className="text-[12px] leading-[1.5] text-mute">
          {t('xmr.scanFrom', {
            height: fmtNumber(status.restoreHeight, 0),
            date: status.tip !== null && status.tipTime !== null ? ` (≈ ${fmtDate(status.tipTime - (status.tip - status.restoreHeight) * 120)})` : '',
          })}
        </span>
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow">{t('xmr.subaddresses')}</span>
        <Button size="md" onClick={() => void create()} disabled={busy}>
          {busy && <Spinner />} {t('xmr.newSubaddress')}
        </Button>
      </div>
      <span className="text-[12px] leading-[1.5] text-mute">
        {t('xmr.subaddressHint')}
      </span>
      {error && <Notice tone="error">{error}</Notice>}
      {subs.length === 0 && list && <span className="text-[12px] text-faint">{t('xmr.noSubaddress')}</span>}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {subs
          .slice()
          .reverse()
          .map((s) => (
            <li key={s.index} className="flex flex-col gap-1.5 rounded-box border border-line bg-bg px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <span className="font-medium text-text2">{t('xmr.subaddressN', { index: s.index })}</span>
                <span className="text-mute">{BigInt(s.received) > 0n ? t('xmr.received', { amount: hidden ? '•••••' : XMR(s.received) }) : t('xmr.nothingReceived')}</span>
              </div>
              <AddressBlocks address={s.address} size="sm" />
              <CopyButton text={s.address} label={t('common.copy')} className="self-start" />
            </li>
          ))}
      </ul>
    </div>
  );
}

/** Réglages › Sécurité: 25-word Monero seed (native window) and restore height. */
export function XmrWalletSection({ adapter }: { adapter: XmrAdapter | null }) {
  useT();
  const [open, setOpen] = useState<'seed' | 'height' | null>(null);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<'height' | 'date'>('date');
  const [value, setValue] = useState('');
  const { status } = useXmrStatus(adapter);
  if (!adapter) return null;

  const close = () => {
    setOpen(null);
    setPw('');
    setError(null);
    setValue('');
  };
  const showSeed = async () => {
    setBusy(true);
    setError(null);
    try {
      await adapter.backend.showSeed(pw);
      setPw('');
      setNotice(t('xmr.seedClosed'));
      setOpen(null);
    } catch (e) {
      const err = toIpcError(e);
      setError(err.code === 'USER_REJECTED' ? t('xmr.seedCancelled') : err.message);
    } finally {
      setBusy(false);
    }
  };
  const target = (() => {
    const v = value.trim();
    if (!v) return null;
    if (mode === 'height') return /^\d{1,9}$/.test(v) ? Number(v) : null;
    const ms = Date.parse(v);
    if (!Number.isFinite(ms) || !status?.tip || !status.tipTime) return null;
    return xmrHeightAt(Math.floor(ms / 1000), status.tip, status.tipTime);
  })();
  const setHeight = async () => {
    if (target === null) return;
    setBusy(true);
    setError(null);
    try {
      await adapter.backend.setRestoreHeight(target);
      await adapter.sync();
      setNotice(t('xmr.rescanStarted', { height: fmtNumber(target, 0) }));
      close();
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-panel border border-line bg-card px-[22px] py-[18px]">
      <div className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] font-semibold">{t('xmr.walletTitle')}</span>
          <span className="text-[12px] leading-[1.5] text-mute">
            {t('xmr.walletDesc')}
            {status && status.restoreHeight !== null ? t('xmr.walletScanFrom', { height: fmtNumber(status.restoreHeight, 0) }) : ''}
          </span>
        </div>
        <Button variant="dangerOutline" size="md" onClick={() => setOpen('seed')}>
          {t('xmr.seedButton')}
        </Button>
        <Button variant="outline" size="md" onClick={() => setOpen('height')}>
          {t('xmr.heightButton')}
        </Button>
      </div>
      {notice && <Notice tone="info">{notice}</Notice>}
      <Dialog open={open === 'seed'} onOpenChange={(v) => (v ? setOpen('seed') : close())} title={t('xmr.seedDialogTitle')} className="w-[600px]">
        <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
          {t('xmr.seedWarn')}
        </Notice>
        <p className="m-0 text-[13px] leading-[1.55] text-text2">{t('xmr.seedHow')}</p>
        <PasswordField id="xmr-seed-pw" value={pw} onChange={setPw} autoFocus onEnter={() => pw && void showSeed()} />
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={!pw || busy} onClick={() => void showSeed()}>
            {busy && <Spinner />} {busy ? t('xmr.systemWindowOpen') : t('xmr.showSeed')}
          </Button>
        </div>
      </Dialog>
      <Dialog open={open === 'height'} onOpenChange={(v) => (v ? setOpen('height') : close())} title={t('xmr.heightDialogTitle')} className="w-[560px]">
        <p className="m-0 text-[13px] leading-[1.55] text-text2">
          {t('xmr.heightHelp')}
        </p>
        <div className="flex gap-2">
          <Button size="md" variant={mode === 'date' ? 'primary' : 'outline'} onClick={() => setMode('date')}>
            {t('xmr.modeDate')}
          </Button>
          <Button size="md" variant={mode === 'height' ? 'primary' : 'outline'} onClick={() => setMode('height')}>
            {t('xmr.modeHeight')}
          </Button>
        </div>
        <Input type={mode === 'date' ? 'date' : 'text'} inputMode={mode === 'height' ? 'numeric' : undefined} value={value} onChange={(e) => setValue(e.target.value)} placeholder={mode === 'height' ? t('xmr.heightPlaceholder') : ''} aria-label={mode === 'date' ? t('xmr.dateLabel') : t('xmr.heightLabel')} />
        <span className="text-[12px] text-mute">
          {target !== null ? t('xmr.startBlock', { height: fmtNumber(target, 0), estimate: mode === 'date' ? t('xmr.startEstimate') : '' }) : mode === 'date' && !status?.tip ? t('xmr.tipUnknown') : ' '}
        </span>
        {status?.running && <Notice tone="warn">{t('xmr.scanRunning')}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={target === null || busy || !!status?.running} onClick={() => void setHeight()}>
            {busy && <Spinner />} {t('xmr.scanFromHere')}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
