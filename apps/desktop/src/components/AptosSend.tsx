// SPDX-License-Identifier: GPL-3.0-or-later
// Aptos pieces of the Send screen (docs/IPC.md §2.11): the Rust-decoded transfer before the
// password (function, fees estimated / reserved, sequence, expiration, new recipient account),
// and the follow-up after submission (aptos_tx_status).

import { useEffect, useState } from 'react';
import type { Currency } from '@kyro/shared';
import type { AptosAdapter, AptosUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat } from '../lib/format';
import { Notice, Spinner } from './ui/primitives';
import { IconCheck, IconWarn } from './icons';
import { cn } from '../lib/cn';
import { t, useT } from '../i18n';
import { rt } from '../i18n/rich';

const APT = (octas: bigint | string) => fmtCrypto(BigInt(octas), 8, 'APT', 8);

/** Rust's decoding, before the password. */
export function AptosSummaryView({ u, aptPrice, currency }: { u: AptosUnsigned; aptPrice: number | null; currency: Currency }) {
  useT();
  const s = u.summary;
  const c = u.context;
  // No « 0,00 € » for a 0.0001 APT fee: fiat only from one cent.
  const fiat = (o: bigint) => {
    const v = aptPrice !== null ? (Number(o) / 1e8) * aptPrice : 0;
    return v >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  const minutes = Math.max(0, Math.ceil((s.expirationTimestampSecs - c.ledgerTime) / 60));
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label={t('aptos.decodedLabel')}>
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">{t('aptos.title')}</span>
        <span className="text-[11px] text-mute">{t('aptos.decodedByVault')}</span>
      </div>
      <Line k={t('aptos.lFunction')} v={s.function} mono />
      {c.recipientNew && <Line k={t('aptos.lDest')} v={t('aptos.lDestCreated')} warn />}
      <Line k={t('aptos.lFeeEstimate')} v={t('aptos.lFeeEstimateValue', { fee: `${APT(u.estimatedFee)}${fiat(u.estimatedFee)}`, units: c.gasUsed, price: s.gasUnitPrice })} />
      <Line k={t('aptos.lFeeMax')} v={t('aptos.lFeeMaxValue', { fee: `${APT(s.maxFee)}${fiat(BigInt(s.maxFee))}`, units: s.maxGasAmount })} />
      <Line k={t('aptos.lBalance')} v={APT(c.account.balance)} />
      <Line k={t('aptos.lSeqChain')} v={`${s.sequenceNumber} · ${s.chainId}`} />
      <Line k={t('aptos.lExpires')} v={t('aptos.lExpiresValue', { minutes })} last />
    </div>
  );
}

function Line({ k, v, warn, last, mono }: { k: string; v: string; warn?: boolean; last?: boolean; mono?: boolean }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-3.5 py-1.5', !last && 'border-b border-line')}>
      <span className="shrink-0 text-text2">{k}</span>
      <span className={cn('text-right break-all', warn ? 'text-warn' : 'text-text2', mono && 'font-mono text-[11px]')}>{v}</span>
    </div>
  );
}

type Status = { state: 'pending' } | { state: 'committed' } | { state: 'failed'; vmStatus: string } | { state: 'expired' } | { state: 'error'; message: string };

/**
 * After `aptos_broadcast`: follows `aptos_tx_status` until the transaction is committed.
 * Success → « confirmée »; failure → « échouée » (the gas used is still taken). Not committed
 * after its expiration (10 min) + margin → it can no longer be included.
 */
export function AptosTxStatusLine({ adapter, hash, onCommitted }: { adapter: AptosAdapter; hash: string; onCommitted?: () => void }) {
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
        if (s.committed) {
          if (s.success) {
            setStatus({ state: 'committed' });
            onCommitted?.();
          } else setStatus({ state: 'failed', vmStatus: s.vmStatus || t('aptos.unknown') });
          return;
        }
        if (Date.now() - started > 660_000) {
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
  }, [adapter, hash]);

  if (status.state === 'pending') {
    return (
      <div role="status" className="flex w-full items-center gap-2 rounded-ctl border border-line bg-raised px-3.5 py-2.5 text-[13px] text-text2">
        <Spinner /> {t('aptos.pending')}
      </div>
    );
  }
  if (status.state === 'committed') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        {rt('aptos.committed', { b: (c) => <strong className="font-semibold">{c}</strong> })}
      </Notice>
    );
  }
  if (status.state === 'failed') {
    return (
      <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />} className="w-full text-left">
        {rt('aptos.failed', { b: (c) => <strong className="font-semibold">{c}</strong> }, { vmStatus: status.vmStatus })}
      </Notice>
    );
  }
  if (status.state === 'expired') {
    return (
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
        {t('aptos.expired')}
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      {t('aptos.trackError', { message: status.message })}
    </Notice>
  );
}
