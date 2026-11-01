// SPDX-License-Identifier: GPL-3.0-or-later
// XRP Ledger pieces of the Send screen (docs/IPC.md §2.6):
// - the destination tag field, ALWAYS visible right under the recipient, mandatory when the
//   destination has lsfRequireDestTag (Rust refuses without it anyway);
// - what Rust will check: activation of a new account (≥ 1 XRP), spendable = balance − reserve;
// - the Rust-decoded payment before the password, and the validation follow-up (xrp_tx_status).

import { useEffect, useState } from 'react';
import type { Currency, XrpAccountInfo } from '@kyro/shared';
import type { XrpAdapter, XrpUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice, Spinner } from './ui/primitives';
import { IconCheck, IconInfo, IconWarn } from './icons';
import { cn } from '../lib/cn';
import { t, useT } from '../i18n';
import { rt } from '../i18n/rich';

export const XRP_ACTIVATION = 1_000_000n;
const XRP = (drops: bigint | string) => fmtCrypto(BigInt(drops), 6, 'XRP', 6);

/** The exchange-deposit warning, shown whenever a destination requires a tag (current language). */
export const exchangeTagHint = (): string => t('send.xrpExchangeTagHint');

export function XrpTagField({
  value,
  onChange,
  error,
  dest,
  destLoading,
}: {
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  /** Destination account as Rust reads it; undefined while unknown. */
  dest: XrpAccountInfo | undefined;
  destLoading: boolean;
}) {
  const { t } = useT();
  const required = !!dest?.requireDestTag;
  const missing = required && value.trim() === '';
  return (
    <div className={cn('flex flex-col gap-2 rounded-box border px-4 py-3.5', missing || error ? 'border-down/60 bg-down/[.05]' : 'border-ice-line bg-ice/[.05]')}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="xrp-tag" className="text-[13px] font-semibold text-text">
          {t('send.xrpTag')} {required ? <span className="text-down">{t('send.xrpTagRequired')}</span> : <span className="font-normal text-mute">{t('send.xrpTagOptional')}</span>}
        </label>
        {destLoading && (
          <span className="flex items-center gap-1.5 text-[11px] text-mute">
            <Spinner /> {t('send.xrpReadingAccount')}
          </span>
        )}
      </div>
      <input
        id="xrp-tag"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={t('send.xrpTagPlaceholder')}
        onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, '').slice(0, 10))}
        aria-invalid={missing || !!error}
        className="h-11 rounded-ctl border border-line-3 bg-bg px-3 font-mono text-[16px] font-semibold text-text focus:border-ice-line"
      />
      {error && <span className="text-[12px] text-down">{error}</span>}
      {required ? (
        <span className={cn('flex items-start gap-1.5 text-[12px] leading-[1.45]', missing ? 'text-down' : 'text-warn')}>
          <IconWarn size={13} className="mt-0.5 shrink-0" />
          <span>
            {missing ? t('send.xrpTagMissing') : t('send.xrpTagCheck')} {t('send.xrpExchangeTagHint')}
          </span>
        </span>
      ) : value.trim() === '' ? (
        <span className="text-[12px] leading-[1.45] text-mute">{t('send.xrpNoTag')}</span>
      ) : (
        <span className="text-[12px] text-mute">{t('send.xrpTagPublic')}</span>
      )}
      {dest && !dest.exists && (
        <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-warn">
          <IconInfo size={13} className="mt-0.5 shrink-0" />
          <span>{t('send.xrpDestNotActivated')}</span>
        </span>
      )}
    </div>
  );
}

/** Spendable = balance − reserve, with the reserve explained. */
export function XrpSpendable({ account, hidden }: { account: XrpAccountInfo | undefined; hidden: boolean }) {
  const { t } = useT();
  if (!account) return null;
  if (!account.exists) {
    return <span className="text-[12px] text-warn">{t('send.xrpSelfNotActivated')}</span>;
  }
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      {rt('send.xrpSpendable', { b: (c) => <strong className="font-semibold text-text2">{c}</strong> }, { spendable: hidden ? '•••••' : XRP(account.spendable), balance: hidden ? '•••••' : XRP(account.balance), reserve: XRP(account.reserve), count: account.ownerCount })}
    </span>
  );
}

/** Rust's decoding, before the password: tag framed, activation, fee, reserve, ledger limit. */
export function XrpSummaryView({ u, xrpPrice, currency }: { u: XrpUnsigned; xrpPrice: number | null; currency: Currency }) {
  const { t } = useT();
  const s = u.summary;
  const c = u.context;
  // No « 0,0000 € » for a 12-drop fee: fiat only from one cent.
  const fiat = (d: string) => {
    const v = xrpPrice !== null ? (Number(BigInt(d)) / 1e6) * xrpPrice : 0;
    return v >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label={t('send.xrpDecodedAria')}>
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">{t('send.xrpPaymentTitle')}</span>
        <span className="text-[11px] text-mute">{t('send.xrpDecodedByVault')}</span>
      </div>
      <div className={cn('mx-3 my-2.5 rounded-ctl border-2 px-3 py-2 text-center', s.destinationTag !== null ? 'border-ice-line' : c.destination.requireDestTag ? 'border-down/60' : 'border-warn/50')}>
        <span className="block text-[12px] font-medium text-mute">{t('send.xrpTag')}</span>
        <span className={cn('block font-mono text-[18px] font-semibold', s.destinationTag !== null ? 'text-text' : 'text-warn')}>{s.destinationTag !== null ? s.destinationTag : t('send.xrpNoTagUpper')}</span>
      </div>
      {!c.destination.exists && <Line k={t('send.xrpDestAccount')} v={t('send.xrpDestCreated')} warn />}
      <Line k={t('common.fees')} v={`${XRP(s.fee)}${fiat(s.fee)}`} />
      <Line k={t('send.xrpYourBalance')} v={XRP(c.account.balance)} />
      <Line k={t('send.xrpLockedReserve')} v={`${XRP(c.account.reserve)} (${XRP(c.reserveBase)} + ${XRP(c.reserveInc)} × ${c.account.ownerCount})`} />
      <Line k={t('send.xrpSpendableShort')} v={XRP(c.account.spendable)} />
      <Line k={t('send.xrpValidUntil')} v={s.lastLedgerSequence !== null ? t('send.xrpLedgerN', { n: s.lastLedgerSequence }) : '—'} last />
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

type Status = { state: 'pending' } | { state: 'validated' } | { state: 'failed'; result: string } | { state: 'expired' } | { state: 'error'; message: string };

/**
 * After `xrp_broadcast`: follows `xrp_tx_status` until the payment is in a validated ledger.
 * `tesSUCCESS` → « validée »; any other result → « échouée » (the fee is still taken). Not found
 * after LastLedgerSequence (≈ 1 min) + margin → it can no longer be included.
 */
export function XrpTxStatusLine({ adapter, hash, recipient, onValidated }: { adapter: XrpAdapter; hash: string; recipient: string; onValidated?: () => void }) {
  const { t } = useT();
  const [status, setStatus] = useState<Status>({ state: 'pending' });
  useEffect(() => {
    let alive = true;
    const started = Date.now();
    let timer = 0;
    const tick = async () => {
      try {
        const s = await adapter.txStatus(hash);
        if (!alive) return;
        if (s.validated) {
          if (s.result === 'tesSUCCESS') {
            setStatus({ state: 'validated' });
            onValidated?.();
          } else setStatus({ state: 'failed', result: s.result || t('common.unknown') });
          return;
        }
        if (Date.now() - started > 120_000) {
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
        <Spinner /> {t('send.xrpPending')}
      </div>
    );
  }
  if (status.state === 'validated') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        {rt('send.xrpValidated', { b: (c) => <strong className="font-semibold">{c}</strong> }, { recipient: shortAddress(recipient) })}
      </Notice>
    );
  }
  if (status.state === 'failed') {
    return (
      <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />} className="w-full text-left">
        {rt('send.xrpFailed', { b: (c) => <strong className="font-semibold">{c}</strong> }, { result: status.result })}
      </Notice>
    );
  }
  if (status.state === 'expired') {
    return (
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
        {t('send.xrpExpired')}
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      {t('send.xrpStatusError', { message: status.message })}
    </Notice>
  );
}
