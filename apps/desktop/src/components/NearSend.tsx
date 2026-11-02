// SPDX-License-Identifier: GPL-3.0-or-later
// NEAR pieces of the Send screen (docs/IPC.md §2.11): - what the receiver is (implicit / named /
// Ethereum-style) and whether it exists, as Rust reads it: a named account must exist, an implicit
// one is created by the transfer; - spendable = balance − storage reserve; - the Rust-decoded
// transfer before the password (fees are NOT in a NEAR transaction: Kyro shows an estimate and the
// bound it checked), and the execution follow-up (near_tx_status).

import { useEffect, useState } from 'react';
import type { Currency, NearAccountInfo } from '@kyro/shared';
import { nearAccountKind, type NearAdapter, type NearUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice, Spinner } from './ui/primitives';
import { IconCheck, IconInfo, IconWarn } from './icons';
import { cn } from '../lib/cn';
import { t, useT } from '../i18n';
import { rt } from '../i18n/rich';

const NEAR = (yocto: bigint | string) => fmtCrypto(BigInt(yocto), 24, 'NEAR', 6);

/** Kind and existence of the receiver, under the recipient field. */
export function NearReceiverLine({ id, info, loading }: { id: string; info: NearAccountInfo | undefined; loading: boolean }) {
  useT();
  const kind = nearAccountKind(id);
  if (!kind) return null;
  if (loading && !info) {
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-mute">
        <Spinner /> {t('near.reading')}
      </span>
    );
  }
  if (!info) return null;
  if (kind === 'named') {
    return info.exists ? (
      <span className="text-[12px] text-mute">{t('near.namedExists', { contract: info.hasContract ? t('near.hasContract') : '' })}</span>
    ) : (
      <span className="text-[12px] text-down">{t('near.namedMissing')}</span>
    );
  }
  if (kind === 'ethImplicit') {
    return info.exists ? (
      <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-warn">
        <IconWarn size={13} className="mt-0.5 shrink-0" />
        <span>{t('near.ethExists')}</span>
      </span>
    ) : (
      <span className="text-[12px] text-down">{t('near.ethMissing')}</span>
    );
  }
  return info.exists ? (
    <span className="text-[12px] text-mute">{t('near.implicitExists')}</span>
  ) : (
    <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-warn">
      <IconInfo size={13} className="mt-0.5 shrink-0" />
      <span>{t('near.implicitMissing')}</span>
    </span>
  );
}

/** A receiver that cannot receive (named / 0x… account that does not exist). */
export function nearReceiverBlocked(id: string, info: NearAccountInfo | undefined): boolean {
  const kind = nearAccountKind(id);
  return !!info && !info.exists && kind !== 'implicit';
}

/** Spendable = balance − storage reserve. */
export function NearSpendable({ account, hidden }: { account: NearAccountInfo | undefined; hidden: boolean }) {
  useT();
  if (!account) return null;
  if (!account.exists) {
    return <span className="text-[12px] text-warn">{t('near.ownMissing')}</span>;
  }
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      {rt(
        'near.spendable',
        { b: (c) => <strong className="font-semibold text-text2">{c}</strong> },
        { spendable: hidden ? '•••••' : NEAR(account.spendable), balance: hidden ? '•••••' : NEAR(account.balance), reserve: hidden ? '•••••' : NEAR(account.storageReserve), usage: account.storageUsage },
      )}
    </span>
  );
}

/** Rust's decoding, before the password. */
export function NearSummaryView({ u, nearPrice, currency }: { u: NearUnsigned; nearPrice: number | null; currency: Currency }) {
  useT();
  const s = u.summary;
  const c = u.context;
  const fiat = (y: string) => {
    const v = nearPrice !== null ? (Number(BigInt(y) / 10n ** 12n) / 1e12) * nearPrice : 0;
    return v >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label={t('near.decodedLabel')}>
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">{t('near.title')}</span>
        <span className="text-[12px] text-mute">{t('near.decodedByVault')}</span>
      </div>
      {s.token ? (
        <>
          <Line k={t('near.lToken')} v={t('near.lTokenValue', { symbol: s.token.symbol, decimals: s.token.decimals })} />
          <Line k={t('near.lContract')} v={s.token.contract} />
          <Line k={t('near.lTokenTo')} v={`${s.token.recipient} · ${s.token.recipientKind === 'named' ? t('near.kindNamed') : s.token.recipientKind === 'implicit' ? t('near.kindImplicit') : t('near.kindEth')}`} warn={s.token.recipientKind === 'ethImplicit'} />
          <Line k={t('near.lTokenAmount')} v={fmtCrypto(BigInt(s.token.amount), s.token.decimals, s.token.symbol, s.token.decimals)} />
          <Line k={t('near.lStorage')} v={s.token.storageDeposit ? t('near.lStorageValue', { amount: NEAR(s.token.storageDeposit) }) : t('near.lStorageNone')} warn={!!s.token.storageDeposit} />
        </>
      ) : (
        <Line k={t('near.lReceiver')} v={`${s.receiverKind === 'named' ? t('near.kindNamed') : s.receiverKind === 'implicit' ? t('near.kindImplicit') : t('near.kindEth')}${c.createsAccount ? t('near.createdByThis') : ''}`} warn={c.createsAccount || s.receiverKind === 'ethImplicit'} />
      )}
      <Line k={t('near.lFeeEstimate')} v={`${NEAR(c.feeEstimate)}${fiat(c.feeEstimate)}`} />
      <Line k={t('near.lFeeBound')} v={t('near.lFeeBoundValue', { fee: NEAR(c.feeBound) })} />
      <Line k={t('near.lBalance')} v={NEAR(c.account.balance)} />
      <Line k={t('near.lReserve')} v={NEAR(c.account.storageReserve)} />
      <Line k={t('near.lSpendable')} v={NEAR(c.account.spendable)} />
      <Line k={t('near.lKeyNonce')} v={`${shortAddress(s.publicKey)} · ${s.nonce}`} />
      <Line k={t('near.lHash')} v={shortAddress(s.hash)} last />
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

type Status = { state: 'pending' } | { state: 'success' } | { state: 'failed'; message: string } | { state: 'late' } | { state: 'error'; message: string };

/** After `near_broadcast`: follows `near_tx_status` until the transfer is executed. */
export function NearTxStatusLine({ adapter, hash, recipient, onDone }: { adapter: NearAdapter; hash: string; recipient: string; onDone?: () => void }) {
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
        if (s.status === 'success') {
          setStatus({ state: 'success' });
          onDone?.();
          return;
        }
        if (s.status === 'failure') {
          setStatus({ state: 'failed', message: s.message });
          return;
        }
        if (Date.now() - started > 120_000) {
          setStatus({ state: 'late' });
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
        <Spinner /> {t('near.pending')}
      </div>
    );
  }
  if (status.state === 'success') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        {rt('near.success', { b: (c) => <strong className="font-semibold">{c}</strong> }, { recipient: shortAddress(recipient) })}
      </Notice>
    );
  }
  if (status.state === 'failed') {
    return (
      <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />} className="w-full text-left">
        {rt('near.failed', { b: (c) => <strong className="font-semibold">{c}</strong> }, { detail: status.message ? ` (${status.message})` : '' })}
      </Notice>
    );
  }
  if (status.state === 'late') {
    return (
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
        {t('near.late')}
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      {t('near.trackError', { message: status.message })}
    </Notice>
  );
}
