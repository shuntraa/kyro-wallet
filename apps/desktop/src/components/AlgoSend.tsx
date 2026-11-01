// SPDX-License-Identifier: GPL-3.0-or-later
// Algorand pieces of the Send screen (docs/IPC.md §2.11):
// - the optional note (public for ever, ≤ 1024 bytes, reinforced confirmation in the vault);
// - what Rust will check: minimum balance (0.1 ALGO) of a new receiver, spendable = balance −
//   minimum balance, rekeyed sender refused;
// - the Rust-decoded payment before the password, and the confirmation follow-up (algo_tx_status).

import { useEffect, useState } from 'react';
import type { AlgoAccountInfo, Currency } from '@kyro/shared';
import { ALGO_MAX_NOTE, algoNoteBytes, type AlgorandAdapter, type AlgoUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice, Spinner } from './ui/primitives';
import { IconCheck, IconInfo, IconWarn } from './icons';
import { cn } from '../lib/cn';
import { t, useT } from '../i18n';
import { rt } from '../i18n/rich';

/** 0.1 ALGO: what a new account must receive at least. */
export const ALGO_ACTIVATION = 100_000n;
const ALGO = (micro: bigint | string) => fmtCrypto(BigInt(micro), 6, 'ALGO', 6);

/** Note field + receiver facts (does it exist? its minimum balance). */
export function AlgoNoteField({ value, onChange, dest, destLoading }: { value: string; onChange: (v: string) => void; dest: AlgoAccountInfo | undefined; destLoading: boolean }) {
  useT();
  const bytes = algoNoteBytes(value);
  const tooLong = bytes > ALGO_MAX_NOTE;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="algo-note" className="eyebrow">
          {t('algo.note')} <span className="font-normal normal-case tracking-normal text-mute">{t('algo.noteHint')}</span>
        </label>
        <span className={cn('text-[11px]', tooLong ? 'text-down' : 'text-faint')}>
          {t('algo.noteBytes', { bytes, max: ALGO_MAX_NOTE })}
        </span>
      </div>
      <input
        id="algo-note"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={t('algo.notePlaceholder')}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={tooLong}
        className="h-11 rounded-ctl border border-line-2 bg-bg px-3 text-[13px] text-text focus:border-ice-line"
      />
      {tooLong && <span className="text-[12px] text-down">{t('algo.noteTooLong')}</span>}
      {value.trim() !== '' && !tooLong && <span className="text-[12px] text-mute">{t('algo.notePublic')}</span>}
      {destLoading && (
        <span className="flex items-center gap-1.5 text-[11px] text-mute">
          <Spinner /> {t('algo.readingDest')}
        </span>
      )}
      {dest && !dest.exists && (
        <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-warn">
          <IconInfo size={13} className="mt-0.5 shrink-0" />
          <span>{t('algo.destMissing', { min: ALGO(dest.minBalance) })}</span>
        </span>
      )}
    </div>
  );
}

/** Spendable = balance − minimum balance, with the minimum explained. */
export function AlgoSpendable({ account, hidden }: { account: AlgoAccountInfo | undefined; hidden: boolean }) {
  useT();
  if (!account) return null;
  if (account.authAddr) {
    return <span className="text-[12px] text-down">{t('algo.rekeyed', { addr: shortAddress(account.authAddr) })}</span>;
  }
  if (!account.exists) {
    return <span className="text-[12px] text-warn">{t('algo.ownMissing')}</span>;
  }
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      {rt(
        'algo.spendable',
        { b: (c) => <strong className="font-semibold text-text2">{c}</strong> },
        { spendable: hidden ? '•••••' : ALGO(account.spendable), balance: hidden ? '•••••' : ALGO(account.balance), min: ALGO(account.minBalance), assets: account.assets },
      )}
    </span>
  );
}

/** Rust's decoding, before the password: receiver, note, fee, network, validity window. */
export function AlgoSummaryView({ u, algoPrice, currency }: { u: AlgoUnsigned; algoPrice: number | null; currency: Currency }) {
  useT();
  const s = u.summary;
  const c = u.context;
  const fiat = (d: string) => {
    const v = algoPrice !== null ? (Number(BigInt(d)) / 1e6) * algoPrice : 0;
    return v >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label={t('algo.decodedLabel')}>
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">{t('algo.title')}</span>
        <span className="text-[11px] text-mute">{t('algo.decodedByVault')}</span>
      </div>
      {!c.destination.exists && <Line k={t('algo.lDest')} v={t('algo.lDestCreated', { min: ALGO(c.destination.minBalance) })} warn />}
      {s.noteLen > 0 && <Line k={t('algo.lNote')} v={s.noteText !== null ? `« ${s.noteText} »` : t('algo.noteBinary', { len: s.noteLen })} warn />}
      <Line k={t('algo.lFee')} v={`${ALGO(s.fee)}${fiat(s.fee)}`} />
      <Line k={t('algo.lBalance')} v={ALGO(c.account.balance)} />
      <Line k={t('algo.lMinBalance')} v={ALGO(c.account.minBalance)} />
      <Line k={t('algo.lSpendable')} v={ALGO(c.account.spendable)} />
      <Line k={t('algo.lNetwork')} v={s.genesisId} />
      <Line k={t('algo.lValid')} v={t('algo.lValidValue', { first: s.firstValid, last: s.lastValid })} />
      <Line k={t('algo.lTxid')} v={shortAddress(s.txid)} last />
    </div>
  );
}

function Line({ k, v, warn, last }: { k: string; v: string; warn?: boolean; last?: boolean }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-3.5 py-1.5', !last && 'border-b border-line')}>
      <span className="text-text2">{k}</span>
      <span className={cn('text-right break-all', warn ? 'text-warn' : 'text-text2')}>{v}</span>
    </div>
  );
}

type Status = { state: 'pending' } | { state: 'confirmed'; round: number | null } | { state: 'dropped'; error: string } | { state: 'expired' } | { state: 'error'; message: string };

/**
 * After `algo_broadcast`: follows `algo_tx_status` until the payment is in a block (≈ 3 s,
 * final immediately on Algorand). A pool error means it was dropped (never confirmed); after the
 * validity window (≈ 9 min) it can no longer be included.
 */
export function AlgoTxStatusLine({ adapter, txid, recipient, onConfirmed }: { adapter: AlgorandAdapter; txid: string; recipient: string; onConfirmed?: () => void }) {
  useT();
  const [status, setStatus] = useState<Status>({ state: 'pending' });
  useEffect(() => {
    let alive = true;
    const started = Date.now();
    let timer = 0;
    const tick = async () => {
      try {
        const s = await adapter.txStatus(txid);
        if (!alive) return;
        if (s.confirmed) {
          setStatus({ state: 'confirmed', round: s.round });
          onConfirmed?.();
          return;
        }
        if (s.error) {
          setStatus({ state: 'dropped', error: s.error });
          return;
        }
        if (Date.now() - started > 600_000) {
          setStatus({ state: 'expired' });
          return;
        }
      } catch (e) {
        if (!alive) return;
        setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
      timer = window.setTimeout(() => void tick(), 2_000);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [adapter, txid]);

  if (status.state === 'pending') {
    return (
      <div role="status" className="flex w-full items-center gap-2 rounded-ctl border border-line bg-raised px-3.5 py-2.5 text-[13px] text-text2">
        <Spinner /> {t('algo.pending')}
      </div>
    );
  }
  if (status.state === 'confirmed') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        {status.round !== null
          ? rt('algo.confirmedRound', { b: (c) => <strong className="font-semibold">{c}</strong> }, { round: status.round, recipient: shortAddress(recipient) })
          : rt('algo.confirmed', { b: (c) => <strong className="font-semibold">{c}</strong> }, { recipient: shortAddress(recipient) })}
      </Notice>
    );
  }
  if (status.state === 'dropped') {
    return (
      <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />} className="w-full text-left">
        {rt('algo.dropped', { b: (c) => <strong className="font-semibold">{c}</strong> }, { error: status.error })}
      </Notice>
    );
  }
  if (status.state === 'expired') {
    return (
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
        {t('algo.expired')}
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      {t('algo.trackError', { message: status.message })}
    </Notice>
  );
}
