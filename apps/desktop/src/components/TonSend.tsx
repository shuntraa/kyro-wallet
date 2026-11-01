// SPDX-License-Identifier: GPL-3.0-or-later
// TON pieces of the Send screen (docs/IPC.md §2.11):
// - the comment field, ALWAYS visible right under the recipient (exchanges ask for one, often
//   called « memo » or « tag »), with Rust's limit (123 bytes);
// - what Rust reads about the recipient: active, never used (the transfer goes without bounce),
//   frozen (refused); the form typed (EQ… bounceable / UQ… non-bounceable);
// - the Rust-decoded transfer before the password, and the follow-up (ton_tx_status).

import { useEffect, useState } from 'react';
import { parseTonAddress, type Currency, type TonAccountInfo } from '@kyro/shared';
import { TON_MAX_COMMENT_BYTES, tonCommentProblem, type TonAdapter, type TonUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice, Spinner } from './ui/primitives';
import { IconCheck, IconInfo, IconWarn } from './icons';
import { cn } from '../lib/cn';
import { t, useT } from '../i18n';
import { rt } from '../i18n/rich';

const TON = (nano: bigint | string) => fmtCrypto(BigInt(nano), 9, 'TON', 9);

export function TonCommentField({
  value,
  onChange,
  to,
  dest,
  destLoading,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Recipient as typed (valid user-friendly address), for the bounce hint. */
  to: string;
  /** Recipient account as Rust reads it; undefined while unknown. */
  dest: TonAccountInfo | undefined;
  destLoading: boolean;
}) {
  useT();
  const bytes = new TextEncoder().encode(value).length;
  const problem = tonCommentProblem(value);
  const parsed = parseTonAddress(to);
  return (
    <div className={cn('flex flex-col gap-2 rounded-box border px-4 py-3.5', problem ? 'border-down/60 bg-down/[.05]' : 'border-ice-line bg-ice/[.05]')}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="ton-comment" className="text-[13px] font-semibold text-text">
          {t('ton.comment')} <span className="font-normal text-mute">{t('ton.commentHint')}</span>
        </label>
        {destLoading ? (
          <span className="flex items-center gap-1.5 text-[11px] text-mute">
            <Spinner /> {t('ton.readingAccount')}
          </span>
        ) : (
          <span className={cn('text-[11px]', bytes > TON_MAX_COMMENT_BYTES ? 'text-down' : 'text-faint')}>
            {t('ton.commentBytes', { bytes, max: TON_MAX_COMMENT_BYTES })}
          </span>
        )}
      </div>
      <input
        id="ton-comment"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={t('ton.commentPlaceholder')}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!problem}
        className="h-11 rounded-ctl border border-line-3 bg-bg px-3 font-mono text-[15px] font-semibold text-text focus:border-ice-line"
      />
      {problem && <span className="text-[12px] text-down">{problem}.</span>}
      {value === '' ? (
        <span className="text-[12px] leading-[1.45] text-mute">{t('ton.noComment')}</span>
      ) : (
        <span className="text-[12px] text-mute">{t('ton.commentClear')}</span>
      )}
      {dest && dest.status !== 'active' && dest.status !== 'frozen' && (
        <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-warn">
          <IconInfo size={13} className="mt-0.5 shrink-0" />
          <span>
            {rt('ton.inactive', { b: (c) => <strong className="font-semibold">{c}</strong> }, { funded: BigInt(dest.balance) > 0n ? t('ton.inactiveFunded') : '' })}
          </span>
        </span>
      )}
      {dest?.status === 'frozen' && <span className="text-[12px] text-down">{t('ton.frozen')}</span>}
      {dest?.status === 'active' && parsed && !parsed.bounceable && (
        <span className="text-[12px] leading-[1.45] text-mute">{t('ton.nonBounceable')}</span>
      )}
    </div>
  );
}

/** Rust's decoding, before the password: comment framed, both address forms, fee, deployment. */
export function TonSummaryView({ u, tonPrice, currency }: { u: TonUnsigned; tonPrice: number | null; currency: Currency }) {
  useT();
  const s = u.summary;
  const c = u.context;
  const fiat = (n: string) => {
    const v = tonPrice !== null ? (Number(BigInt(n)) / 1e9) * tonPrice : 0;
    return v >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  const mins = Math.max(0, Math.ceil((s.validUntil * 1000 - Date.now()) / 60_000));
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label={t('ton.decodedLabel')}>
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">{t('ton.title')}</span>
        <span className="text-[11px] text-mute">{t('ton.decodedByVault')}</span>
      </div>
      <div className={cn('mx-3 my-2.5 rounded-ctl border-2 px-3 py-2 text-center', s.comment !== null ? 'border-ice-line' : 'border-warn/50')}>
        <span className="block text-[12px] font-medium text-mute">{t('ton.comment')}</span>
        <span className={cn('block font-mono text-[16px] font-semibold break-all', s.comment !== null ? 'text-text' : 'text-warn')}>{s.comment !== null ? s.comment : t('ton.commentNone')}</span>
      </div>
      <Line k={t('ton.lDest')} v={s.destination} mono />
      <Line k={t('ton.lDestOther')} v={s.destinationOther} mono />
      <Line k={t('ton.lAmount')} v={s.sendAll ? t('ton.sendAll') : `${TON(s.amount)}${fiat(s.amount)}`} {...(s.sendAll ? { warn: true } : {})} />
      <Line k={t('ton.lBounce')} v={s.bounce ? t('ton.bounceYes') : c.destination.status === 'active' ? t('ton.bounceNoForm') : t('ton.bounceNoInactive')} />
      <Line k={t('ton.lFee')} v={t('ton.lFeeValue', { fee: `${TON(c.fee)}${fiat(c.fee)}` })} />
      {s.deploysWallet && <Line k={t('ton.lFirstSend')} v={t('ton.deploys')} warn />}
      <Line k={t('ton.lBalance')} v={TON(c.account.balance)} />
      <Line k={t('ton.lValid')} v={t('ton.lValidValue', { minutes: mins, seqno: s.seqno })} last />
    </div>
  );
}

function Line({ k, v, warn, mono, last }: { k: string; v: string; warn?: boolean; mono?: boolean; last?: boolean }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-3.5 py-1.5', !last && 'border-b border-line')}>
      <span className="shrink-0 text-text2">{k}</span>
      <span className={cn('text-right', mono && 'font-mono text-[11px] break-all', warn ? 'text-warn' : 'text-text2')}>{v}</span>
    </div>
  );
}

type Status = { state: 'pending' } | { state: 'done' } | { state: 'failed' } | { state: 'expired' } | { state: 'error'; message: string };

/**
 * After `ton_broadcast`: follows `ton_tx_status` (normalized message hash) until our wallet's
 * transaction is found. Not found after the message's 10-minute validity + margin → it can no
 * longer be processed.
 */
export function TonTxStatusLine({ adapter, hash, recipient, onDone }: { adapter: TonAdapter; hash: string; recipient: string; onDone?: () => void }) {
  useT();
  const [status, setStatus] = useState<Status>({ state: 'pending' });
  useEffect(() => {
    let alive = true;
    const started = Date.now();
    let timer = 0;
    const tick = async () => {
      try {
        const s = await adapter.txStatus(hash);
        if (!alive) return;
        if (s.found) {
          setStatus(s.success ? { state: 'done' } : { state: 'failed' });
          if (s.success) onDone?.();
          return;
        }
        if (Date.now() - started > 12 * 60_000) {
          setStatus({ state: 'expired' });
          return;
        }
      } catch (e) {
        if (!alive) return;
        setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
      // TON Center's public tier: about one request per second for the whole app.
      timer = window.setTimeout(() => void tick(), 4_000);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [adapter, hash]);

  if (status.state === 'pending') {
    return (
      <div role="status" className="flex w-full items-center gap-2 rounded-ctl border border-line bg-raised px-3.5 py-2.5 text-[13px] text-text2">
        <Spinner /> {t('ton.pending')}
      </div>
    );
  }
  if (status.state === 'done') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        {rt('ton.done', { b: (c) => <strong className="font-semibold">{c}</strong> }, { recipient: shortAddress(recipient) })}
      </Notice>
    );
  }
  if (status.state === 'failed') {
    return (
      <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />} className="w-full text-left">
        {rt('ton.failed', { b: (c) => <strong className="font-semibold">{c}</strong> })}
      </Notice>
    );
  }
  if (status.state === 'expired') {
    return (
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
        {t('ton.expired')}
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      {t('ton.trackError', { message: status.message })}
    </Notice>
  );
}
