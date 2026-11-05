// SPDX-License-Identifier: GPL-3.0-or-later
// Bitcoin time locks: the list, a new lock, the withdrawal, the details, and "Find my locks".
// Rust decides everything that matters (docs/BTC_TIMELOCK.md); this screen only asks.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { call, intlLocale, toIpcError, type BtcLockInfo, type BtcLockScanStep, type BtcLocksStatus, type BtcLockView, type BtcLockWithdrawPreview } from '@kyro/shared';
import { assetsFor, parseUnits, type BitcoinAdapter, type FeeEstimates, type FeeLevel } from '@kyro/chains';
import { useApp, useVault } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { confirmWord, dateOfLockTime, isHeld, localToday, LOCK_MIN_SATS, LOCK_SHORTCUTS, lockDateError, lockTimeLeft, lockTimeOf, maxLockDate, minLockDate, shortcutDate, unlockLocal, unlockUtc } from '../lib/btcLock';
import { fmtCrypto, fmtFiat } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { AddressBlocks, CopyButton, EmptyState, EnClair, HIDDEN, PasswordField } from '../components/kit';
import { Dialog } from '../components/ui/dialog';
import { Button, IconButton, Input, Label, Notice, Segmented, Spinner } from '../components/ui/primitives';
import { IconBack } from '../components/icons';
import { useT } from '../i18n';

const REFRESH_MS = 60_000;
const btc = (sats: bigint | number) => fmtCrypto(BigInt(sats), 8, 'BTC');

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
  const rate = level === 'custom' ? Math.floor(Number(custom)) : option?.family === 'btc' ? option.satPerVb : 0;
  const levels: Array<{ value: FeeLevel | 'custom'; label: string }> = [
    { value: 'slow', label: t('send.feeSlow') },
    { value: 'normal', label: t('send.feeNormal') },
    { value: 'fast', label: t('send.feeFast') },
    { value: 'custom', label: t('lock.form.customFee') },
  ];
  return { rate: Number.isFinite(rate) && rate >= 1 ? rate : 0, level, setLevel, custom, setCustom, levels };
}

function FeePicker({ fee, label }: { fee: ReturnType<typeof useLockFees>; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label={label} value={fee.level} onChange={fee.setLevel} options={fee.levels} />
        {fee.level === 'custom' ? <Input aria-label={label} inputMode="numeric" className="w-28" value={fee.custom} onChange={(e) => fee.setCustom(e.target.value.replace(/\D/g, ''))} /> : null}
        <span className="figure text-[13px] text-mute">{fee.rate > 0 ? `${fee.rate} sat/vB` : '—'}</span>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-t border-line py-2.5 text-[13.5px]">
      <span className="shrink-0 text-mute">{label}</span>
      <span className="min-w-0 text-right text-text">{children}</span>
    </div>
  );
}

type Duration = (typeof LOCK_SHORTCUTS)[number] | 'custom';

function NewLock({ adapter, onClose, onDone }: { adapter: BitcoinAdapter; onClose: () => void; onDone: () => void }) {
  const { t, tp, lang } = useT();
  const { network } = useApp();
  const pf = usePortfolio();
  const asset = useMemo(() => assetsFor(network).find((a) => a.family === 'btc' && a.kind === 'native'), [network]);
  const balance = asset ? pf.balances.get(asset.id) ?? 0n : 0n;
  const now = useMemo(() => new Date(), []);
  const locale = intlLocale();
  const fee = useLockFees(adapter);
  const [amount, setAmount] = useState('');
  const [duration, setDuration] = useState<Duration>(30);
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
      <section className="flex max-w-[640px] flex-col gap-4">
        <h2 className="text-[20px] font-medium tracking-[-0.02em]">{t('lock.done.title')}</h2>
        <EnClair>{t('lock.review.plain', { amount: btc(review.unsigned.amount), date: unlockUtc(review.info.t, locale) })}</EnClair>
        <p className="m-0 text-[14px] leading-[1.55] text-text2">{t('lock.done.body')}</p>
        <div>
          <Button variant="primary" size="lg" onClick={onClose}>
            {t('lock.back')}
          </Button>
        </div>
      </section>
    );
  }

  if (review) {
    return (
      <section className="flex max-w-[640px] flex-col gap-4">
        <h2 className="text-[20px] font-medium tracking-[-0.02em]">{t('lock.review.title')}</h2>
        <EnClair tone="warn">{t('lock.review.plain', { amount: btc(review.unsigned.amount), date: unlockUtc(review.info.t, locale) })}</EnClair>
        <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-[14px] leading-[1.55] text-text2">
          <li className="text-text">{t('lock.review.final')}</li>
          <li>{t('lock.review.phrase')}</li>
          <li>{t('lock.review.feeLater')}</li>
        </ul>
        <div className="flex flex-col">
          <Row label={t('lock.review.unlock')}>{t('lock.review.unlockValue', { local: unlockLocal(review.info.t, locale) })}</Row>
          <Row label={t('lock.review.fee')}>{btc(review.unsigned.fee)}</Row>
          <div className="flex flex-col gap-2 border-t border-b border-line py-2.5">
            <span className="text-[13.5px] text-mute">{t('lock.review.address')}</span>
            <AddressBlocks address={review.info.address} size="sm" />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="lock-word">{t('lock.review.word', { word: expected })}</Label>
          <Input id="lock-word" autoComplete="off" spellCheck={false} value={word} onChange={(e) => setWord(e.target.value)} />
        </div>
        <PasswordField id="lock-password" value={password} onChange={setPassword} wrong={wrong} />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="flex gap-2">
          <Button variant="primary" size="lg" disabled={busy || word.trim() !== expected || !password} onClick={() => void confirm()}>
            {busy ? t('lock.review.sending') : t('lock.review.confirm')}
          </Button>
          <Button size="lg" disabled={busy} onClick={() => setReview(null)}>
            {t('common.back')}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex max-w-[640px] flex-col gap-5">
      <h2 className="text-[20px] font-medium tracking-[-0.02em]">{t('lock.form.title')}</h2>
      <div className="flex flex-col gap-2">
        <Label htmlFor="lock-amount">{t('lock.form.amount')}</Label>
        <Input id="lock-amount" inputMode="decimal" autoComplete="off" placeholder="0.00" className="figure h-12 text-[18px]" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <span className="text-[13px] text-mute">{t('lock.form.available', { amount: btc(balance) })}</span>
        {amountError ? <span className="text-[13px] text-down">{amountError}</span> : <span className="text-[13px] text-faint">{t('lock.form.min')}</span>}
      </div>
      <div className="flex flex-col gap-2">
        <Label>{t('lock.form.shortcuts')}</Label>
        <Segmented<Duration>
          label={t('lock.form.shortcuts')}
          value={duration}
          onChange={setDuration}
          options={[...LOCK_SHORTCUTS.map((d) => ({ value: d as Duration, label: d === 365 ? t('lock.form.year') : tp('lock.form.days', d) })), { value: 'custom' as Duration, label: t('lock.form.custom') }]}
        />
        {duration === 'custom' ? (
          <div className="flex flex-col gap-2 pt-1">
            <Label htmlFor="lock-date">{t('lock.form.date')}</Label>
            <Input id="lock-date" type="date" className="w-48" min={minLockDate(now)} max={maxLockDate(now)} value={custom} onChange={(e) => setCustom(e.target.value || localToday(now))} />
          </div>
        ) : null}
      </div>
      {dateError ? (
        <span className="text-[13px] text-down">{dateError === 'tooSoon' ? t('lock.form.tooSoon') : dateError === 'tooFar' ? t('lock.form.tooFar', { date: maxLockDate(now) }) : t('lock.form.invalidDate')}</span>
      ) : t0 !== null ? (
        <EnClair>
          <span className="flex flex-col gap-1">
            <span>{t('lock.form.unlockAt', { local: unlockLocal(t0, locale), utc: unlockUtc(t0, locale) })}</span>
            <span className="text-text2">{t('lock.form.delay')}</span>
          </span>
        </EnClair>
      ) : null}
      <FeePicker fee={fee} label={t('lock.form.fee')} />
      <p className="m-0 text-[13px] text-mute">{t('lock.form.feeNote')}</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="flex gap-2">
        <Button variant="primary" size="lg" disabled={!ready || busy} onClick={() => void prepare()}>
          {busy ? <Spinner /> : null} {t('lock.form.continue')}
        </Button>
        <Button size="lg" disabled={busy} onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </section>
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
          <Button variant="primary" size="lg" onClick={onClose}>
            {t('lock.back')}
          </Button>
        </>
      ) : (
        <>
          <FeePicker fee={fee} label={t('lock.withdraw.fee')} />
          {preview ? (
            <div className="flex flex-col">
              <Row label={t('lock.withdraw.receive')}>
                <span className="figure text-[16px]">{btc(preview.amountSats)}</span>
              </Row>
              <Row label={t('lock.withdraw.fee')}>{btc(preview.feeSats)}</Row>
              <div className="flex flex-col gap-2 border-t border-b border-line py-2.5">
                <span className="text-[13.5px] text-mute">{t('lock.withdraw.dest')}</span>
                <AddressBlocks address={preview.destination} size="sm" />
              </div>
              {preview.leftOut > 0 ? <span className="pt-2 text-[13px] text-mute">{tp('lock.withdraw.leftOut', preview.leftOut)}</span> : null}
            </div>
          ) : null}
          <PasswordField id="lock-withdraw-password" value={password} onChange={setPassword} wrong={wrong} />
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Button variant="primary" size="lg" disabled={!preview || !password || busy} onClick={() => void run()}>
            {busy ? <Spinner /> : null} {t('lock.withdraw.confirm')}
          </Button>
        </>
      )}
    </Dialog>
  );
}

function Details({ lock, onClose }: { lock: BtcLockView; onClose: () => void }) {
  const { t } = useT();
  const info = useAsync<BtcLockInfo>(() => call('btc_lock_details', { t: lock.t, account: lock.account }), [lock.t, lock.account]);
  const field = (label: string, value: string) => (
    <div className="flex flex-col gap-1.5 border-t border-line py-2.5">
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
  const [step, setStep] = useState<BtcLockScanStep | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [found, setFound] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  const start = useCallback(async () => {
    setRunning(true);
    setError(null);
    let from = cursor;
    let total = found;
    try {
      for (;;) {
        const s = await call('btc_locks_scan', { fromDay: from, account });
        total += s.found;
        setStep(s);
        setFound(total);
        if (s.found > 0) onFound();
        if (s.nextDay === null) {
          setFinished(true);
          break;
        }
        from = s.nextDay;
        setCursor(from);
      }
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setRunning(false);
    }
  }, [cursor, found, account, onFound]);

  const percent = step ? Math.round(((((step.nextDay ?? step.lastDay + 1) - step.firstDay) / (step.lastDay + 1 - step.firstDay)) * 100)) : 0;
  return (
    <Dialog open onOpenChange={(v) => !v && !running && onClose()} title={t('lock.scan.title')} description={t('lock.scan.body')}>
      <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-[13.5px] leading-[1.5] text-text2">
        <li>{t('lock.scan.privacy', { count: step ? step.lastDay + 1 - step.firstDay : 3_660 })}</li>
        <li>{t('lock.scan.account')}</li>
      </ul>
      {running || step ? (
        <div className="flex flex-col gap-2">
          <span className="text-[13.5px] text-text2">{t('lock.scan.running', { percent })}</span>
          <div className="h-[3px] overflow-hidden rounded-full bg-control-2">
            <div className="h-full rounded-full bg-ice transition-[width] duration-300" style={{ width: `${percent}%` }} />
          </div>
          {found > 0 ? <span className="text-[13.5px] text-text">{tp('lock.scan.foundSoFar', found)}</span> : null}
        </div>
      ) : null}
      {finished && found === 0 ? <Notice>{t('lock.scan.none')}</Notice> : null}
      {error ? <Notice tone="error">{t('lock.scan.failed', { error })}</Notice> : null}
      {finished ? (
        <Button size="lg" onClick={onClose}>
          {t('lock.back')}
        </Button>
      ) : (
        <Button variant="primary" size="lg" disabled={running} onClick={() => void start()}>
          {running ? <Spinner /> : null} {error ? t('lock.scan.resume') : t('lock.scan.start')}
        </Button>
      )}
    </Dialog>
  );
}

const STATUS_TONE: Record<BtcLockView['status'], string> = {
  confirming: 'text-warn',
  locked: 'text-text2',
  ready: 'text-ice',
  withdrawn: 'text-faint',
  notFound: 'text-warn',
  unknown: 'text-mute',
};

export function BtcLocks() {
  const { back, hideBalances, settings, activeWatch } = useApp();
  const { adapters, activeHw } = useVault();
  const { t } = useT();
  const pf = usePortfolio();
  const { status, reload, error } = useBtcLocks();
  const adapter = adapters.btc ?? null;
  const allowed = !!adapter?.canLock && !activeWatch && !activeHw;
  const [creating, setCreating] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [details, setDetails] = useState<BtcLockView | null>(null);
  const [withdrawing, setWithdrawing] = useState<BtcLockView | null>(null);
  const locale = intlLocale();
  const locks = status?.locks ?? [];
  const held = locks.filter((l) => isHeld(l.status));
  const sats = status?.lockedSats ?? 0;
  const price = pf.price('bitcoin')?.price;
  const units = { d: t('lock.day'), h: t('lock.hour'), m: t('lock.minute') };
  const done = () => {
    reload();
    pf.refresh();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 pt-7 pb-6 scroll-thin">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <IconButton label={t('common.back')} onClick={back} className="size-9">
            <IconBack size={16} />
          </IconButton>
          <h1 className="screen-title">{t('lock.title')}</h1>
        </div>
        {allowed && !creating ? (
          <div className="flex gap-2">
            <Button variant="primary" size="lg" onClick={() => setCreating(true)}>
              {t('lock.new')}
            </Button>
            <Button size="lg" onClick={() => setScanning(true)}>
              {t('lock.find')}
            </Button>
          </div>
        ) : null}
      </header>

      {!allowed ? <Notice>{t('lock.softwareOnly')}</Notice> : null}

      {creating && adapter ? (
        <NewLock adapter={adapter} onClose={() => setCreating(false)} onDone={done} />
      ) : (
        <>
          <section className="flex flex-col gap-2 border-b border-line pb-6">
            <span className="eyebrow">{t('lock.total')}</span>
            <span className="figure text-[52px] leading-none tracking-[-0.045em]">{hideBalances ? HIDDEN : btc(sats)}</span>
            {price && sats > 0 ? <span className="text-[14px] text-text2">{hideBalances ? HIDDEN : fmtFiat((sats / 1e8) * price, settings.currency)}</span> : null}
            <p className="m-0 max-w-[620px] pt-1 text-[14px] leading-[1.55] text-mute">{t('lock.intro')}</p>
            {held.length > 0 ? <p className="m-0 text-[13px] text-faint">{t('lock.notInBalance')}</p> : null}
          </section>

          {status?.damaged ? <Notice tone="warn">{t('lock.damaged')}</Notice> : null}
          {status?.stale || (error && !status) ? <Notice tone="warn">{t('lock.stale')}</Notice> : null}

          {locks.length === 0 ? (
            status ? <EmptyState title={t('lock.empty')}>{t('lock.emptyHint')}</EmptyState> : <Spinner />
          ) : (
            <section aria-label={t('lock.title')} className="flex flex-col">
              <div className="grid grid-cols-[1.4fr_1.1fr_.9fr_.9fr_auto] gap-4 pb-2 text-[12.5px] text-faint">
                <span>{t('lock.colDate')}</span>
                <span className="text-right">{t('lock.colAmount')}</span>
                <span className="text-right">{t('lock.colLeft')}</span>
                <span>{t('lock.colStatus')}</span>
                <span className="w-[176px]" />
              </div>
              {locks.map((l) => (
                <div key={`${l.account}-${l.t}`} className="grid grid-cols-[1.4fr_1.1fr_.9fr_.9fr_auto] items-center gap-4 border-t border-line py-3 text-[14px]">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-text">{unlockUtc(l.t, locale)}</span>
                    <span className="truncate text-[12.5px] text-faint">{l.account > 0 ? `${t('lock.account', { n: l.account + 1 })} · ` : ''}{dateOfLockTime(l.t)} 00:00 UTC</span>
                  </span>
                  <span className="figure text-right text-[15px]">{hideBalances ? HIDDEN : btc(l.amountSats)}</span>
                  <span className="figure text-right text-text2">{l.status === 'locked' || l.status === 'confirming' ? lockTimeLeft(l.secsLeft, units) : '—'}</span>
                  <span className={STATUS_TONE[l.status]}>{t(`lock.status.${l.status}`)}</span>
                  <span className="flex w-[176px] justify-end gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setDetails(l)}>
                      {t('lock.details')}
                    </Button>
                    {l.status === 'ready' && allowed ? (
                      <Button size="sm" variant="ice" onClick={() => setWithdrawing(l)}>
                        {t('lock.withdraw')}
                      </Button>
                    ) : null}
                  </span>
                </div>
              ))}
            </section>
          )}
        </>
      )}

      {details ? <Details lock={details} onClose={() => setDetails(null)} /> : null}
      {withdrawing && adapter ? <Withdraw lock={withdrawing} adapter={adapter} onClose={() => setWithdrawing(null)} onDone={done} /> : null}
      {scanning && adapter ? <Scan account={adapter.account} onClose={() => setScanning(false)} onFound={reload} /> : null}
    </div>
  );
}
