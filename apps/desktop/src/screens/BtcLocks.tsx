// SPDX-License-Identifier: GPL-3.0-or-later
// Bitcoin time locks: the list, a new lock, the withdrawal, the details, and "Find my locks".
// Rust decides everything that matters (docs/BTC_TIMELOCK.md); this screen only asks.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { call, intlLocale, toIpcError, type BtcLockInfo, type BtcLocksStatus, type BtcLockView, type BtcLockWithdrawPreview } from '@kyro/shared';
import { assetsFor, parseUnits, type BitcoinAdapter, type FeeEstimates, type FeeLevel } from '@kyro/chains';
import { useApp, useVault } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { confirmWord, isHeld, localToday, LOCK_DAY_SECS, LOCK_MIN_SATS, LOCK_SHORTCUTS, lockDateError, lockElapsed, lockFeeRate, lockStartMs, lockScanStart, lockTimeLeft, lockTimeOf, maxLockDate, minLockDate, runLockScan, shortcutDate, unlockUtc, withdrawableAt } from '../lib/btcLock';
import { cn } from '../lib/cn';
import { fmtAgo, fmtCrypto, fmtDate, fmtFiat, sanitizeDecimalInput } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { AddressBlocks, CopyButton, HIDDEN, PasswordField } from '../components/kit';
import { Annotated, BIG, CoinPill, Frost, GLASS_ROW, GLOW, GlassButton, IceDot, IceSquare, LABEL, Segmented, Side, THIN, type Note, type Seg } from '../components/kyro';
import { useWidth } from '../components/kyroParts';
import { useHistory } from '../state/history';
import { LockTimeline } from '../components/LockTimeline';
import { Dialog } from '../components/ui/dialog';
import { Input, Label, Notice, Spinner } from '../components/ui/primitives';
import { IconBack } from '../components/icons';
import { useT } from '../i18n';

const REFRESH_MS = 60_000;
const BTC = '#F7931A';
const btc = (sats: bigint | number) => fmtCrypto(BigInt(sats), 8, 'BTC');
const HERO: React.CSSProperties = { ...THIN, ...BIG(BTC) };
const zeroBtc = (locale: string) => new Intl.NumberFormat(locale, { minimumFractionDigits: 4 }).format(0);

/** The figure, its unit smaller, both in the coin's light. */
function Btc({ sats, hidden, className, style }: { sats: bigint | number; hidden?: boolean; className?: string; style?: React.CSSProperties }) {
  if (hidden) return <span className={className} style={style}>{HIDDEN}</span>;
  return (
    <span className={className} style={style}>
      {btc(sats).replace(/\s*BTC$/, '')}
      <span className="ml-3 text-[0.43em]">BTC</span>
    </span>
  );
}

/** Back, then the screen's name in spaced capitals. */
function Head({ title, onBack, children }: { title: string; onBack: () => void; children?: React.ReactNode }) {
  const { t } = useT();
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-2.5">
        <button type="button" aria-label={t('common.back')} title={t('common.back')} onClick={onBack} className="press -ml-1 grid size-7 place-items-center rounded-ctl text-faint hover:text-text">
          <IconBack size={14} />
        </button>
        <h1 className={cn(LABEL, 'm-0')}>{title}</h1>
      </div>
      {children}
    </header>
  );
}

type Duration = (typeof LOCK_SHORTCUTS)[number] | 'custom';

/** Lock length shortcuts, the chosen one lit in bitcoin orange. */
function Durations({ value, onChange }: { value: Duration; onChange: (d: Duration) => void }) {
  const { t, tp } = useT();
  const items: Array<{ id: Duration; label: string }> = [...LOCK_SHORTCUTS.map((d) => ({ id: d as Duration, label: d === 365 ? t('lock.form.year') : tp('lock.form.days', d) })), { id: 'custom', label: t('lock.form.dateShort') }];
  return (
    <div role="radiogroup" aria-label={t('lock.form.shortcuts')} className="flex flex-wrap gap-1.5 text-[12.5px] font-medium">
      {items.map((it) => {
        const on = it.id === value;
        return (
          <button key={it.id} type="button" role="radio" aria-checked={on} onClick={() => onChange(it.id)} className={cn('press rounded-[11px] px-3 py-2 transition-colors duration-150', on ? 'text-text' : cn('text-faint hover:text-text2', GLASS_ROW))} style={on ? { background: `${BTC}14`, boxShadow: `inset 0 0 0 1.5px ${BTC}aa, 0 0 16px ${BTC}22` } : undefined}>
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/** The locks of the open wallet, refreshed in the background. `null` until the first answer. */
export function useBtcLocks() {
  const { activeWatch } = useApp();
  const { adapters } = useVault();
  const enabled = !!adapters.btc?.canLock && !activeWatch;
  const state = useAsync<BtcLocksStatus>(enabled ? () => call('btc_locks_status') : null, [enabled], { intervalMs: REFRESH_MS });
  return { status: state.data ?? null, reload: state.reload, loading: state.loading, error: state.error, enabled };
}

/** "Locked 0.0016 BTC": beside the balance, so that locked funds never look lost. */
export function LockedLine({ className }: { className?: string }) {
  const { navigate, hideBalances, settings } = useApp();
  const pf = usePortfolio();
  const { t } = useT();
  const { status } = useBtcLocks();
  const sats = status?.lockedSats ?? 0;
  if (sats <= 0) return null;
  const price = pf.price('bitcoin')?.price;
  const fiat = price ? ` · ${fmtFiat((sats / 1e8) * price, settings.currency)}` : '';
  return (
    <button type="button" aria-label={t('lock.lineAria')} onClick={() => navigate({ name: 'btcLocks' })} className={`press flex items-baseline gap-2 text-left text-[13.5px] ${className ?? ''}`}>
      <span className="text-mute">{t('lock.line')}</span>
      <span className="font-medium text-text2">{hideBalances ? HIDDEN : `${btc(sats)}${fiat}`}</span>
    </button>
  );
}

function useLockFees(adapter: BitcoinAdapter | null) {
  const fees = useAsync<FeeEstimates>(adapter ? () => adapter.estimateFees() : null, [adapter], { intervalMs: 30_000 });
  const [level, setLevel] = useState<FeeLevel | 'custom'>('normal');
  const [custom, setCustom] = useState('');
  const { t } = useT();
  const option = level === 'custom' ? null : fees.data?.options[level].params;
  const rate = lockFeeRate(level === 'custom' ? Number(custom) : option?.family === 'btc' ? option.satPerVb : 0);
  const levels: Array<{ value: FeeLevel | 'custom'; label: string }> = [
    { value: 'slow', label: t('send.feeSlow') },
    { value: 'normal', label: t('send.feeNormal') },
    { value: 'fast', label: t('send.feeFast') },
    { value: 'custom', label: t('lock.form.customFee') },
  ];
  return { rate, level, setLevel, custom, setCustom, levels };
}

function FeePicker({ fee, label }: { fee: ReturnType<typeof useLockFees>; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="figure text-[13px] text-mute">{fee.rate > 0 ? `${fee.rate} sat/vB` : '—'}</span>
      {fee.level === 'custom' ? <Input aria-label={label} inputMode="numeric" className="w-24" value={fee.custom} onChange={(e) => fee.setCustom(e.target.value.replace(/\D/g, ''))} /> : null}
      <Segmented label={label} value={fee.level} onChange={fee.setLevel} items={fee.levels.map((l) => ({ id: l.value, label: l.label }))} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-t border-white/[.06] py-2.5 text-[13px]">
      <span className="shrink-0 text-mute">{label}</span>
      <span className="min-w-0 text-right text-text">{children}</span>
    </div>
  );
}

function NewLock({ adapter, locks, initial, onClose, onDone }: { adapter: BitcoinAdapter; locks: Array<{ t: number; sats: number }>; initial: { amount: string; duration: Duration }; onClose: () => void; onDone: () => void }) {
  const { t, lang } = useT();
  const { network, settings } = useApp();
  const pf = usePortfolio();
  const asset = useMemo(() => assetsFor(network).find((a) => a.family === 'btc' && a.kind === 'native'), [network]);
  const balance = asset ? pf.balances.get(asset.id) ?? 0n : 0n;
  const price = pf.price('bitcoin')?.price;
  const now = useMemo(() => new Date(), []);
  const locale = intlLocale();
  const fee = useLockFees(adapter);
  const [amount, setAmount] = useState(initial.amount);
  const [duration, setDuration] = useState<Duration>(initial.duration);
  const [custom, setCustom] = useState(shortcutDate(now, 30));
  const [review, setReview] = useState<{ info: BtcLockInfo; unsigned: Awaited<ReturnType<BitcoinAdapter['buildTx']>> } | null>(null);
  const [word, setWord] = useState('');
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const date = duration === 'custom' ? custom : shortcutDate(now, duration);
  const dateError = lockDateError(date, now);
  const t0 = lockTimeOf(date);
  const sats = useMemo(() => {
    try {
      return amount ? parseUnits(amount.replace(',', '.'), 8) : 0n;
    } catch {
      return -1n;
    }
  }, [amount]);
  const amountError = !amount ? null : sats < LOCK_MIN_SATS ? t('lock.form.tooSmall') : sats > balance ? t('lock.form.tooMuch') : null;
  const ready = !!asset && amount !== '' && !amountError && !dateError && t0 !== null && fee.rate > 0;

  const prepare = async () => {
    if (!ready || !asset || t0 === null) return;
    setBusy(true);
    setError(null);
    try {
      const info = await call('btc_lock_preview', { t: t0, account: adapter.account });
      const unsigned = await adapter.buildTx({ asset, to: info.address, amount: sats, fee: { family: 'btc', satPerVb: fee.rate } });
      setReview({ info, unsigned });
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const expected = confirmWord(lang);
  const zero = new Intl.NumberFormat(locale, { minimumFractionDigits: 2 }).format(0);
  const confirm = async () => {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      const signed = await adapter.signLockFunding(review.unsigned, password, review.info.t, word.trim());
      await adapter.broadcast(signed);
      setPassword('');
      setSent(true);
      onDone();
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') setWrong((n) => n + 1);
      else if (err.code !== 'SPEND_LIMIT') setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (sent && review) {
    return (
      <>
        <Head title={t('lock.done.title')} onBack={onClose} />
        <section className="flex flex-col items-center gap-3 pb-4 text-center">
          <Btc sats={review.unsigned.amount} className="text-[46px] leading-none" style={HERO} />
          <span className="text-[18px] text-text2" style={THIN}>{t('lock.review.until', { date: unlockUtc(review.info.t, locale) })}</span>
        </section>
        <LockTimeline locks={locks.filter((l) => l.t !== review.info.t)} draft={{ t: review.info.t, sats: Number(review.unsigned.amount) }} />
        <p className="m-0 text-center text-[13.5px] leading-[1.55] text-text2">{t('lock.done.body')}</p>
        <div className="flex justify-center">
          <Frost className="w-[220px]" onClick={onClose}>
            {t('lock.back')}
          </Frost>
        </div>
      </>
    );
  }

  if (review) {
    return (
      <>
        <Head title={t('lock.review.title')} onBack={() => !busy && setReview(null)} />
        <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-10">
          <section className={cn('flex min-w-0 flex-col rounded-[20px] px-6 pt-5 pb-3', GLASS_ROW)}>
            <span className={cn(LABEL, 'pb-3')}>{t('lock.review.you')}</span>
            <Btc sats={review.unsigned.amount} className="text-[46px] leading-none" style={HERO} />
            <span className="pt-3 pb-6 text-[18px] text-text2" style={THIN}>{t('lock.review.until', { date: unlockUtc(review.info.t, locale) })}</span>
            <Row label={t('lock.review.withdrawAt')}>{t('lock.review.withdrawValue', { when: withdrawableAt(review.info.t, locale) })}</Row>
            <Row label={t('lock.review.fee')}>{btc(review.unsigned.fee)}</Row>
            <div className="flex flex-col gap-2.5 border-t border-white/[.06] py-3">
              <span className="text-[13.5px] text-mute">{t('lock.review.address')}</span>
              <AddressBlocks address={review.info.address} size="sm" />
            </div>
          </section>
          <section className="flex min-w-0 flex-col gap-5">
            <div className="flex flex-col gap-2 border-l-2 border-warn py-0.5 pl-4">
              <span className="text-[16px] font-medium tracking-[-0.015em] text-text">{t('lock.review.finalTitle')}</span>
              <p className="m-0 text-[14px] leading-[1.55] text-text2">{t('lock.review.final')}</p>
              <p className="m-0 text-[14px] leading-[1.55] text-text2">{t('lock.review.phrase')}</p>
              <p className="m-0 text-[14px] leading-[1.55] text-text2">{t('lock.review.feeLater')}</p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="lock-word">{t('lock.review.word', { word: expected })}</Label>
              <Input id="lock-word" autoComplete="off" spellCheck={false} value={word} onChange={(e) => setWord(e.target.value)} />
            </div>
            <PasswordField id="lock-password" value={password} onChange={setPassword} wrong={wrong} />
            {error ? <Notice tone="error">{error}</Notice> : null}
            <Frost className="w-full" disabled={busy || word.trim() !== expected || !password} onClick={() => void confirm()}>
              {busy ? t('lock.review.sending') : t('lock.review.confirm', { amount: btc(review.unsigned.amount) })}
            </Frost>
          </section>
        </div>
      </>
    );
  }

  const fiat = price && sats > 0n ? fmtFiat((Number(sats) / 1e8) * price, settings.currency) : null;
  return (
    <>
      <Head title={t('lock.form.title')} onBack={onClose} />
      <section className={cn('grid grid-cols-2 rounded-[20px]', GLASS_ROW)}>
        <div className="flex min-w-0 flex-col gap-3 px-6 py-5">
          <label htmlFor="lock-amount" className={LABEL}>
            {t('lock.form.amount')}
          </label>
          <div className="flex items-baseline text-[40px] leading-none" style={THIN}>
            <span className="relative inline-block min-w-0 pr-px">
              <span aria-hidden className="invisible whitespace-pre">
                {amount || zero}
              </span>
              <input id="lock-amount" inputMode="decimal" autoComplete="off" autoFocus placeholder={zero} className="absolute inset-0 w-full min-w-0 border-0 bg-transparent p-0 text-text outline-none placeholder:text-faint" style={{ font: 'inherit', letterSpacing: 'inherit' }} value={amount} onChange={(e) => setAmount(sanitizeDecimalInput(e.target.value, 8))} />
            </span>
            <span className="ml-3 text-[17px]" style={GLOW(BTC)}>
              BTC
            </span>
          </div>
          <span className="flex h-5 items-center gap-2 text-[13.5px]">
            {amountError ? <span className="text-down">{amountError}</span> : <span className="text-mute">{fiat ? `≈ ${fiat}` : t('lock.form.min')}</span>}
            <span className="text-faint">·</span>
            <span className="text-mute">{t('lock.form.available', { amount: btc(balance) })}</span>
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-3 border-l border-white/[.06] px-6 py-5">
          <span className={LABEL}>{t('lock.form.date')}</span>
          <span className={cn('truncate text-[40px] leading-none', t0 === null && 'text-faint')} style={THIN}>{t0 === null ? '—' : unlockUtc(t0, locale)}</span>
          <span className="flex h-5 items-center text-[13.5px]">
            {dateError ? <span className="text-down">{dateError === 'tooSoon' ? t('lock.form.tooSoon') : dateError === 'tooFar' ? t('lock.form.tooFar', { date: maxLockDate(now) }) : t('lock.form.invalidDate')}</span> : t0 !== null ? <span className="text-mute">{t('lock.form.withdrawAt', { when: withdrawableAt(t0, locale) })}</span> : null}
          </span>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Durations value={duration} onChange={setDuration} />
            {duration === 'custom' ? <Input aria-label={t('lock.form.date')} type="date" className="w-40" min={minLockDate(now)} max={maxLockDate(now)} value={custom} onChange={(e) => setCustom(e.target.value || localToday(now))} /> : null}
          </div>
        </div>
      </section>
      <LockTimeline locks={locks} draft={t0 !== null && !dateError ? { t: t0, sats: !amountError && sats > 0n ? Number(sats) : 0 } : null} />
      <section className={cn('flex flex-wrap items-center justify-between gap-4 rounded-[18px] px-5 py-3.5', GLASS_ROW)}>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[14px] text-text2">{t('lock.form.fee')}</span>
          <span className="text-[13px] text-mute">{t('lock.form.feeNote')}</span>
        </span>
        <FeePicker fee={fee} label={t('lock.form.fee')} />
      </section>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="flex gap-2">
        <Frost className="w-[220px]" disabled={!ready || busy} onClick={() => void prepare()}>
          {busy ? <Spinner /> : null} {t('lock.form.continue')}
        </Frost>
        <GlassButton className="h-12 rounded-[15px] px-6" disabled={busy} onClick={onClose}>
          {t('common.cancel')}
        </GlassButton>
      </div>
    </>
  );
}

function Withdraw({ lock, adapter, onClose, onDone }: { lock: BtcLockView; adapter: BitcoinAdapter; onClose: () => void; onDone: () => void }) {
  const { t, tp } = useT();
  const locale = intlLocale();
  const fee = useLockFees(adapter);
  const [preview, setPreview] = useState<BtcLockWithdrawPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (fee.rate <= 0) return;
    let live = true;
    setError(null);
    call('btc_lock_withdraw_preview', { t: lock.t, account: lock.account, satPerVb: fee.rate })
      .then((p) => live && setPreview(p))
      .catch((e: unknown) => {
        if (!live) return;
        setPreview(null);
        setError(toIpcError(e).message);
      });
    return () => {
      live = false;
    };
  }, [fee.rate, lock.t, lock.account]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call('btc_lock_withdraw', { t: lock.t, account: lock.account, satPerVb: fee.rate, password });
      setPassword('');
      setDone(t('lock.withdraw.done', { amount: btc(r.amountSats) }));
      onDone();
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') setWrong((n) => n + 1);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()} title={t('lock.withdraw.title', { date: unlockUtc(lock.t, locale) })} description={t('lock.withdraw.onlyOwn')}>
      {done ? (
        <>
          <Notice tone="success">{done}</Notice>
          <Frost onClick={onClose}>{t('lock.back')}</Frost>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-2 border-t border-white/[.06] pt-4">
            <span className={LABEL}>{t('lock.withdraw.receive')}</span>
            <span className={cn('text-[40px] leading-none', !preview && 'text-faint')} style={preview ? HERO : THIN}>{preview ? <Btc sats={preview.amountSats} /> : '—'}</span>
          </div>
          <div className="flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[.06] py-2.5">
              <span className="text-[13.5px] text-mute">{t('lock.withdraw.fee')}</span>
              <FeePicker fee={fee} label={t('lock.withdraw.fee')} />
            </div>
            {preview ? (
              <>
                <Row label={t('lock.withdraw.feeAmount')}>{btc(preview.feeSats)}</Row>
                <div className="flex flex-col gap-2 border-t border-b border-white/[.06] py-2.5">
                  <span className="text-[13.5px] text-mute">{t('lock.withdraw.dest')}</span>
                  <AddressBlocks address={preview.destination} size="sm" />
                </div>
                {preview.leftOut > 0 ? <span className="pt-2 text-[13px] text-mute">{tp('lock.withdraw.leftOut', preview.leftOut, { amount: btc(preview.leftOutSats) })}</span> : null}
                {preview.unconfirmedSats > 0 ? <span className="pt-2 text-[13px] text-mute">{t('lock.withdraw.unconfirmed', { amount: btc(preview.unconfirmedSats) })}</span> : null}
              </>
            ) : null}
          </div>
          <PasswordField id="lock-withdraw-password" value={password} onChange={setPassword} wrong={wrong} />
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Frost disabled={!preview || !password || busy} onClick={() => void run()}>
            {busy ? <Spinner /> : null} {t('lock.withdraw.confirm')}
          </Frost>
        </>
      )}
    </Dialog>
  );
}

function Details({ lock, onClose }: { lock: BtcLockView; onClose: () => void }) {
  const { t } = useT();
  const info = useAsync<BtcLockInfo>(() => call('btc_lock_details', { t: lock.t, account: lock.account }), [lock.t, lock.account]);
  const field = (label: string, value: string) => (
    <div className="flex flex-col gap-1.5 border-t border-white/[.06] py-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13.5px] text-mute">{label}</span>
        <CopyButton text={value} variant="ghost" />
      </div>
      <span className="font-mono text-[12.5px] leading-[1.5] break-all text-text2">{value}</span>
    </div>
  );
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={t('lock.details.title')} description={t('lock.details.keep')} className="w-[620px]">
      {info.data ? (
        <div className="flex flex-col">
          <Row label={t('lock.details.end')}>{`${unlockUtc(lock.t, intlLocale())}, 00:00 UTC`}</Row>
          {field(t('lock.details.descriptor'), info.data.descriptor)}
          {field(t('lock.details.path'), info.data.path)}
          {field(t('lock.details.time'), String(info.data.t))}
          {field(t('lock.details.address'), info.data.address)}
        </div>
      ) : (
        <Spinner />
      )}
      <span className="text-[13px] text-mute">{t('lock.details.doc')}</span>
    </Dialog>
  );
}

function Scan({ account, onClose, onFound }: { account: number; onClose: () => void; onFound: () => void }) {
  const { t, tp } = useT();
  const locale = intlLocale();
  const [progress, setProgress] = useState(lockScanStart);
  const [running, setRunning] = useState(false);

  const start = useCallback(async () => {
    setRunning(true);
    await runLockScan(
      (fromDay) => call('btc_locks_scan', { fromDay, account }),
      progress,
      (p) => {
        setProgress(p);
        if (p.found > 0) onFound();
      },
    );
    setRunning(false);
  }, [progress, account, onFound]);

  const { firstDay, lastDay, reachedDay, found, finished, error } = progress;
  const span = firstDay !== null && lastDay !== null ? lastDay + 1 - firstDay : null;
  const percent = span && reachedDay !== null && firstDay !== null ? Math.round(((reachedDay + 1 - firstDay) / span) * 100) : 0;
  const dayText = (day: number) => unlockUtc(day * LOCK_DAY_SECS, locale);
  return (
    <Dialog open onOpenChange={(v) => !v && !running && onClose()} title={t('lock.scan.title')} description={t('lock.scan.body')}>
      <p className="m-0 text-[13.5px] leading-[1.55] text-text2">
        {t('lock.scan.privacy', { count: span ?? 3_660 })} {t('lock.scan.account')}
      </p>
      {running || reachedDay !== null ? (
        <div className="flex flex-col gap-2">
          <span className="text-[13.5px] text-text2">{t('lock.scan.running', { percent })}</span>
          <div className="h-[3px] overflow-hidden rounded-full bg-white/[.08]">
            <div className="h-full rounded-full bg-ice shadow-[0_0_8px_#7cc4ff] transition-[width] duration-300" style={{ width: `${percent}%` }} />
          </div>
          {found > 0 ? <span className="text-[13.5px] text-text">{tp('lock.scan.foundSoFar', found)}</span> : null}
        </div>
      ) : null}
      {finished && found === 0 ? <Notice>{t('lock.scan.none')}</Notice> : null}
      {error ? (
        <Notice tone="error">
          <span className="flex flex-col gap-1">
            <span>{t('lock.scan.failed', { error: toIpcError(error).message })}</span>
            <span>{reachedDay !== null && lastDay !== null ? t('lock.scan.reached', { date: dayText(reachedDay), last: dayText(lastDay) }) : t('lock.scan.notStarted')}</span>
          </span>
        </Notice>
      ) : null}
      {finished ? (
        <GlassButton className="h-12 rounded-[15px]" onClick={onClose}>
          {t('lock.back')}
        </GlassButton>
      ) : (
        <Frost disabled={running} onClick={() => void start()}>
          {running ? <Spinner /> : null} {error ? t('lock.scan.resume') : t('lock.scan.start')}
        </Frost>
      )}
    </Dialog>
  );
}

const DOT: Record<BtcLockView['status'], string> = {
  confirming: 'bg-warn',
  locked: 'border-[1.5px] border-[#F7931A]',
  ready: 'bg-[#F7931A] shadow-[0_0_8px_#F7931A]',
  withdrawn: 'bg-faint',
  notFound: 'bg-warn',
  unknown: 'bg-mute',
};

/** Time-lock vault notes: a small coloured square beside two lines. */
const sq = (c: string) => <span key="i" className="size-[9px] rounded-[2px]" style={{ background: c, boxShadow: `0 0 8px ${c}` }} />;

export function BtcLocks() {
  const { back, hideBalances, settings, activeWatch } = useApp();
  const { adapters, activeHw } = useVault();
  const { t, tp } = useT();
  const pf = usePortfolio();
  const history = useHistory();
  const { status, reload, error } = useBtcLocks();
  const adapter = adapters.btc ?? null;
  const allowed = !!adapter?.canLock && !activeWatch && !activeHw;
  const [creating, setCreating] = useState<{ amount: string; duration: Duration } | null>(null);
  const [amount, setAmount] = useState('');
  const [duration, setDuration] = useState<Duration>(30);
  const [scanning, setScanning] = useState(false);
  const [details, setDetails] = useState<BtcLockView | null>(null);
  const [withdrawing, setWithdrawing] = useState<BtcLockView | null>(null);
  const [stageRef, stageW] = useWidth<HTMLDivElement>();
  const locale = intlLocale();
  const locks = status?.locks ?? [];
  const held = locks.filter((l) => isHeld(l.status));
  const timeline = held.map((l) => ({ t: l.t, sats: l.amountSats }));
  const next = held.filter((l) => l.status === 'locked' || l.status === 'confirming').sort((a, b) => a.t - b.t)[0];
  const ordered = [...held.sort((a, b) => a.t - b.t), ...locks.filter((l) => !isHeld(l.status))];
  const sats = status?.lockedSats ?? 0;
  const price = pf.price('bitcoin')?.price;
  const units = { d: t('lock.day'), h: t('lock.hour'), m: t('lock.minute') };
  const done = () => {
    reload();
    pf.refresh();
  };

  const fiatOf = (amount: number) => (price ? fmtFiat((amount / 1e8) * price, settings.currency) : null);
  const left = (l: BtcLockView) => {
    const word = t(`lock.status.${l.status}`);
    return l.status === 'locked' || l.status === 'confirming' ? `${word} · ${t('lock.leftAfter', { time: lockTimeLeft(l.secsLeft, units) })}` : word;
  };
  /** When the lock started: the funding's block time read by Rust (`fundedAt`), otherwise when
   *  the funding left this wallet according to the history (Electrum, Bitcoin Core). */
  const lockedAt = (l: BtcLockView): number | null =>
    lockStartMs(
      l.fundedAt,
      (history.data?.entries ?? []).filter((e) => e.asset?.family === 'btc' && e.counterparty === l.address && e.time).map((e) => e.time!),
    );

  // The ring: the next lock to open. Elapsed time in bitcoin orange, what is left in ice.
  const focus = next ?? held.filter((l) => l.status === 'ready').sort((a, b) => a.t - b.t)[0] ?? null;
  const nowMs = Date.now();
  const start = focus && focus.status !== 'ready' ? lockedAt(focus) : null;
  const elapsed = focus ? lockElapsed(start, focus.t, nowMs) : null;
  const segs: Seg[] = !focus ? [{ color: '#cfe7ff', part: 1, ice: true }] : focus.status === 'ready' ? [{ color: BTC, part: 1 }] : elapsed !== null ? [{ color: BTC, part: elapsed }, { color: '#cfe7ff', part: 1 - elapsed, ice: true }] : [{ color: '#cfe7ff', part: 1, ice: true }];
  const freeSeg = segs.length - 1;
  const notes: Note[] = !focus
    ? []
    : [
        ...(start !== null && elapsed !== null
          ? [
              {
                seg: 0,
                side: 'R' as const,
                dy: 60,
                dot: BTC,
                node: (
                  <Side side="R" icon={sq(BTC)}>
                    <span key="a" className="text-[13.5px] font-semibold">{t('lock.lockedOn', { date: fmtDate(start) })}</span>
                    <span key="b" className="text-[12.5px] text-mute">{fmtAgo(start, nowMs)}</span>
                  </Side>
                ),
              },
            ]
          : []),
        {
          seg: freeSeg,
          side: 'L' as const,
          ...(focus.status === 'ready' ? { dot: BTC } : {}),
          node: (
            <Side side="L" icon={focus.status === 'ready' ? sq(BTC) : <span key="i" className="size-[9px] rounded-[2px] bg-[#cfe7ff] shadow-[0_0_8px_#7cc4ff]" />}>
              <span key="a" className="text-[13.5px] font-semibold">{t(focus.status === 'ready' ? 'lock.freeSince' : 'lock.freeOn', { date: unlockUtc(focus.t, locale) })}</span>
              <span key="b" className="text-[12.5px] text-mute">{focus.status === 'ready' ? t('lock.status.ready') : t('lock.leftAfter', { time: lockTimeLeft(focus.secsLeft, units) })}</span>
            </Side>
          ),
        },
      ];
  const days = focus ? Math.ceil(focus.secsLeft / LOCK_DAY_SECS) : 0;
  const W = Math.min(1200, Math.max(stageW, 0));
  const fiat = sats > 0 ? fiatOf(sats) : null;

  if (creating && adapter) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 pt-7 pb-6 scroll-thin">
        <NewLock adapter={adapter} locks={timeline} initial={creating} onClose={() => setCreating(null)} onDone={done} />
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto scroll-thin">
      <div aria-hidden="true" className="pointer-events-none absolute left-1/2 -translate-x-1/2" style={{ top: 120, width: 900, height: 380, background: `radial-gradient(closest-side, ${BTC}1c, ${BTC}06 55%, transparent)` }} />
      <section aria-label={t('lock.vault')} className="relative flex flex-col pb-8">
        {status?.damaged || status?.stale || (error && !status) ? (
          <div className="mx-auto mt-4 flex w-full max-w-[964px] flex-col gap-2 px-8">
            {status?.damaged ? <Notice tone="warn">{t('lock.damaged')}</Notice> : null}
            {status?.stale || (error && !status) ? <Notice tone="warn">{t('lock.stale')}</Notice> : null}
          </div>
        ) : null}
        <div ref={stageRef} className="mt-4 w-full">
          {W > 0 && (
            <Annotated W={W} H={270} size={226} segs={segs} notes={W >= 960 ? notes : []} halo={focus ? '#7cc4ff' : undefined}>
              {!focus ? (
                status ? <IceSquare size={44} /> : <Spinner />
              ) : focus.status === 'ready' ? (
                <span className="text-[17px]" style={{ ...THIN, ...BIG(BTC) }}>
                  {t('lock.status.ready')}
                </span>
              ) : (
                <span className="flex flex-col items-center">
                  <span className="text-[38px] leading-none" style={{ ...THIN, textShadow: '0 0 24px rgba(124,196,255,.5)' }}>
                    {days}
                  </span>
                  <span className="mt-1.5 text-[11.5px] text-faint">{tp('lock.ringDays', days)}</span>
                </span>
              )}
            </Annotated>
          )}
        </div>

        <div className="mt-4 flex flex-col items-center px-8 text-center">
          <span className="flex items-center gap-2">
            <button type="button" aria-label={t('common.back')} title={t('common.back')} onClick={back} className="press -ml-9 grid size-7 place-items-center rounded-ctl text-faint hover:text-text">
              <IconBack size={14} />
            </button>
            <span className={LABEL}>{t('lock.vault')}</span>
          </span>
          {held.length > 0 ? (
            <>
              <span className="mt-3 text-[46px] leading-none" style={{ ...THIN, ...BIG(BTC) }}>
                <Btc sats={sats} hidden={hideBalances} />
              </span>
              <span className="figure mt-3 text-[13px] text-text2">
                {fiat ? `${hideBalances ? HIDDEN : fiat} · ` : ''}
                {t('lock.onChain')}
                {held.length > 1 ? ` · ${tp('lock.count', held.length)}` : ''}
              </span>
            </>
          ) : status ? (
            <>
              <span className="mt-3 text-[30px] leading-none text-text2" style={THIN}>
                {t('lock.empty')}
              </span>
              <span className="mt-3 max-w-[520px] text-[13px] text-mute">{t('lock.emptyHint')}</span>
            </>
          ) : null}
        </div>

        <div className={cn('mx-auto mt-7 grid w-[calc(100%-64px)] max-w-[900px] grid-cols-3 rounded-[18px]', GLASS_ROW)}>
          {(['before', 'chain', 'exit'] as const).map((k, i) => (
            <span key={k} className={cn('flex flex-col gap-1 px-5 py-3.5', i && 'border-l border-white/[.06]')}>
              <span className="flex items-center gap-2 text-[12.5px] font-semibold">
                <IceDot />
                {t(`lock.fact.${k}`)}
              </span>
              <span className="text-[12.5px] leading-snug text-mute">{t(`lock.fact.${k}Body`)}</span>
            </span>
          ))}
        </div>

        {allowed ? (
          <div className="mx-auto mt-6 flex w-[calc(100%-64px)] max-w-[900px] flex-wrap items-center gap-3">
            <label className={cn('flex h-12 w-[210px] items-center gap-2 rounded-[15px] px-4 transition-shadow focus-within:ring-[#F7931A]/50', GLASS_ROW)}>
              <span className="sr-only">{t('lock.form.amount')}</span>
              <input inputMode="decimal" autoComplete="off" placeholder={zeroBtc(locale)} className="figure min-w-0 flex-1 bg-transparent text-[15px] text-text placeholder:text-faint" value={amount} onChange={(e) => setAmount(sanitizeDecimalInput(e.target.value, 8))} onKeyDown={(e) => e.key === 'Enter' && setCreating({ amount, duration })} />
              <span className="text-[12.5px] font-semibold" style={GLOW(BTC)}>
                BTC
              </span>
            </label>
            <Durations value={duration} onChange={setDuration} />
            <Frost className="ml-auto w-[220px]" onClick={() => setCreating({ amount, duration })}>
              {t('lock.prepare')}
            </Frost>
          </div>
        ) : (
          <div className="mx-auto mt-6 w-[calc(100%-64px)] max-w-[900px]">
            <Notice>{t('lock.softwareOnly')}</Notice>
          </div>
        )}

        <section aria-label={t('lock.title')} className="mx-auto mt-12 flex w-[calc(100%-64px)] max-w-[900px] flex-col">
          <div className="flex min-h-9 items-center gap-3 pb-3">
            <span className={LABEL}>{t('lock.title')}</span>
            {allowed ? (
              <GlassButton className="ml-auto h-9 rounded-[12px] text-[12.5px]" onClick={() => setScanning(true)}>
                {t('lock.find')}
              </GlassButton>
            ) : null}
          </div>
          {timeline.length > 0 ? <LockTimeline locks={timeline} hidden={hideBalances} className="mx-2 mb-3" /> : null}
          {ordered.length > 0 ? (
            <div className={cn('overflow-hidden rounded-[20px]', GLASS_ROW)}>
              {ordered.map((l, i) => (
                <div key={`${l.account}-${l.t}`} className={cn('grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] items-center gap-6 px-5 py-3', i && 'border-t border-white/[.05]', l.status === 'withdrawn' && 'opacity-60')}>
                  <span className="flex min-w-0 items-center gap-3.5">
                    <span aria-hidden className={cn('size-2 shrink-0 rounded-[2px]', DOT[l.status])} />
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span className="truncate text-[13.5px] font-semibold">{unlockUtc(l.t, locale)}</span>
                      <span className={cn('truncate text-[11.5px]', l.status === 'ready' ? 'text-[#F7931A]' : l.status === 'notFound' ? 'text-warn' : 'text-faint')}>
                        {l.account > 0 ? `${t('lock.account', { n: l.account + 1 })} · ` : ''}
                        {left(l)}
                      </span>
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-col items-end leading-tight">
                    <span className="figure text-[14px] font-semibold" style={hideBalances || l.status === 'withdrawn' ? undefined : GLOW(BTC)}>
                      {hideBalances ? HIDDEN : btc(l.amountSats)}
                    </span>
                    <span className="truncate text-[11.5px] text-faint">{l.unconfirmedSats > 0 && l.status !== 'confirming' ? t('lock.unconfirmedNote', { amount: hideBalances ? HIDDEN : btc(l.unconfirmedSats) }) : hideBalances ? HIDDEN : fiatOf(l.amountSats)}</span>
                  </span>
                  <span className="flex justify-end gap-2">
                    <GlassButton className="h-9 rounded-[12px] text-[12.5px]" onClick={() => setDetails(l)}>
                      {t('lock.details')}
                    </GlassButton>
                    {l.status === 'ready' && allowed ? (
                      <CoinPill c={BTC} className="h-9 min-w-[110px] px-4 text-[12.5px]" onClick={() => setWithdrawing(l)}>
                        {t('lock.withdraw')}
                      </CoinPill>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </section>

      {details ? <Details lock={details} onClose={() => setDetails(null)} /> : null}
      {withdrawing && adapter ? <Withdraw lock={withdrawing} adapter={adapter} onClose={() => setWithdrawing(null)} onDone={done} /> : null}
      {scanning && adapter ? <Scan account={adapter.account} onClose={() => setScanning(false)} onFound={reload} /> : null}
    </div>
  );
}
