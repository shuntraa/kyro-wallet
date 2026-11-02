// SPDX-License-Identifier: GPL-3.0-or-later
// Stellar pieces of the Send screen (docs/IPC.md §2.11): - the memo field, ALWAYS visible right
// under the recipient (text / identifiant / hash), mandatory when the destination requires one
// (SEP-0029; Rust refuses without it anyway); - what Rust will check: creation of a new account (≥
// 1 XLM, CreateAccount), spendable = balance − reserve (the reserve explained); - the Rust-decoded
// transaction before the password, and the inclusion follow-up.

import { useEffect, useState } from 'react';
import { toIpcError, type Currency, type StellarAccountInfo, type StellarMemoSpec } from '@kyro/shared';
import type { StellarAdapter, StellarUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { PasswordField } from './kit';
import { Dialog } from './ui/dialog';
import { Button, Notice, Spinner } from './ui/primitives';
import { IconCheck, IconInfo, IconWarn } from './icons';
import { cn } from '../lib/cn';
import { t, useT, type Key } from '../i18n';
import { rt } from '../i18n/rich';

/** 2 × base reserve (0.5 XLM): the minimum to create an account. */
export const XLM_ACTIVATION = 10_000_000n;
const XLM = (stroops: bigint | string) => fmtCrypto(BigInt(stroops), 7, 'XLM', 7);

export type StellarMemoKind = StellarMemoSpec['kind'];

/**
 * Receive side of Stellar's issued assets (Circle's USDC): a trustline is needed before the asset
 * can be received.
 */
export function StellarTrustPanel({ adapter, hidden }: { adapter: StellarAdapter; hidden: boolean }) {
  useT();
  const lines = useAsync(() => adapter.trustlines(), [adapter]);
  const [pending, setPending] = useState<{ contract: string; symbol: string; enable: boolean } | null>(null);
  if (!lines.data) return lines.error ? <Notice tone="warn">{lines.error.message}</Notice> : null;
  const acc = lines.data[0]?.account;
  return (
    <div className="flex flex-col gap-2 rounded-box border border-line px-3.5 py-3 text-[13px]">
      <span className="eyebrow">{t('stellar.trustTitle')}</span>
      {lines.data.map(({ asset, line }) => (
        <div key={asset.contract} className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-text2">
            {line
              ? t('stellar.trustOn', { symbol: asset.symbol, balance: hidden ? '•••••' : fmtCrypto(BigInt(line.balance), 7, asset.symbol, 7) })
              : t('stellar.trustOff', { symbol: asset.symbol, reserve: XLM(acc?.baseReserve ?? '5000000') })}
          </span>
          {line ? (
            <Button size="sm" disabled={line.balance !== '0'} title={line.balance !== '0' ? t('stellar.trustRemoveNotEmpty') : undefined} onClick={() => setPending({ contract: asset.contract ?? '', symbol: asset.symbol, enable: false })}>
              {t('stellar.trustRemove', { symbol: asset.symbol })}
            </Button>
          ) : (
            <Button size="sm" variant="primary" disabled={!acc?.exists} onClick={() => setPending({ contract: asset.contract ?? '', symbol: asset.symbol, enable: true })}>
              {t('stellar.trustEnable', { symbol: asset.symbol })}
            </Button>
          )}
        </div>
      ))}
      <span className="text-[12px] leading-[1.45] text-mute">{rt('stellar.trustExplain', { b: (c) => <strong className="font-semibold text-text2">{c}</strong> }, { reserve: XLM(acc?.baseReserve ?? '5000000') })}</span>
      {acc && !acc.exists && <span className="text-[12px] font-semibold text-warn">{t('stellar.trustNeedsAccount')}</span>}
      {pending && (
        <StellarTrustDialog
          adapter={adapter}
          {...pending}
          reserve={acc?.baseReserve ?? '5000000'}
          onClose={(done) => {
            setPending(null);
            if (done) lines.reload();
          }}
        />
      )}
    </div>
  );
}

function StellarTrustDialog({ adapter, contract, symbol, enable, reserve, onClose }: { adapter: StellarAdapter; contract: string; symbol: string; enable: boolean; reserve: string; onClose: (done: boolean) => void }) {
  useT();
  const [pw, setPw] = useState('');
  const [wrongPw, setWrongPw] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const unsigned = await adapter.buildTrust(contract, enable);
      const signed = await adapter.signTx(unsigned, pw);
      await adapter.broadcast(signed);
      onClose(true);
    } catch (e) {
      const err = toIpcError(e);
      if (err.code === 'WRONG_PASSWORD') setWrongPw((n) => n + 1);
      else setError(err.code === 'USER_REJECTED' ? t('stellar.trustCancelled') : err.message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={() => !busy && onClose(false)} title={enable ? t('stellar.trustEnable', { symbol }) : t('stellar.trustRemove', { symbol })}>
      <p className="m-0 text-[13px] leading-[1.55] text-text2">{enable ? t('stellar.trustEnableExplain', { symbol, reserve: XLM(reserve) }) : t('stellar.trustRemoveExplain', { symbol, reserve: XLM(reserve) })}</p>
      <PasswordField id="xlm-trust-pw" value={pw} onChange={setPw} autoFocus wrong={wrongPw} onEnter={() => pw && !busy && void go()} />
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={() => onClose(false)} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button variant={enable ? 'primary' : 'danger'} disabled={!pw || busy} onClick={() => void go()}>
          {busy && <Spinner />} {enable ? t('stellar.trustEnable', { symbol }) : t('stellar.trustRemove', { symbol })}
        </Button>
      </div>
    </Dialog>
  );
}

const KINDS: Array<{ value: StellarMemoKind; label: Key; placeholder: Key }> = [
  { value: 'id', label: 'stellar.kindId', placeholder: 'stellar.phId' },
  { value: 'text', label: 'stellar.kindText', placeholder: 'stellar.phText' },
  { value: 'hash', label: 'stellar.kindHash', placeholder: 'stellar.phHash' },
];

export function StellarMemoField({
  kind,
  onKind,
  value,
  onChange,
  error,
  dest,
  destLoading,
}: {
  kind: StellarMemoKind;
  onKind: (k: StellarMemoKind) => void;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  dest: StellarAccountInfo | undefined;
  destLoading: boolean;
}) {
  useT();
  const required = !!dest?.memoRequired;
  const empty = value.trim() === '';
  const missing = required && empty;
  const k = KINDS.find((x) => x.value === kind) ?? KINDS[0]!;
  return (
    <div className={cn('flex flex-col gap-2 rounded-box border px-4 py-3.5', missing || error ? 'border-down/60 bg-down/[.05]' : 'border-ice-line bg-ice/[.05]')}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="xlm-memo" className="text-[13px] font-semibold text-text">
          {t('stellar.memo')} {required ? <span className="text-down">{t('stellar.memoRequired')}</span> : <span className="font-normal text-mute">{t('stellar.memoOptional')}</span>}
        </label>
        {destLoading && (
          <span className="flex items-center gap-1.5 text-[12px] text-mute">
            <Spinner /> {t('stellar.readingAccount')}
          </span>
        )}
      </div>
      <div role="radiogroup" aria-label={t('stellar.memoKindLabel')} className="flex gap-1.5">
        {KINDS.map((x) => (
          <button
            key={x.value}
            type="button"
            role="radio"
            aria-checked={kind === x.value}
            onClick={() => onKind(x.value)}
            className={cn('press h-7 rounded-[5px] border px-2.5 text-[12px] font-medium', kind === x.value ? 'border-ice/40 bg-ice/[.1] text-ice-text' : 'border-line-2 text-text2 hover:border-line-3')}
          >
            {(t as (k: Key) => string)(x.label)}
          </button>
        ))}
      </div>
      <input
        id="xlm-memo"
        type="text"
        inputMode={kind === 'id' ? 'numeric' : 'text'}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={(t as (k: Key) => string)(k.placeholder)}
        onChange={(e) => onChange(kind === 'id' ? e.target.value.replace(/[^\d]/g, '').slice(0, 20) : kind === 'hash' ? e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 64) : e.target.value)}
        aria-invalid={missing || !!error}
        className="h-11 rounded-ctl border border-line-3 bg-bg px-3 font-mono text-[15px] font-semibold text-text focus:border-ice-line"
      />
      {error && <span className="text-[12px] text-down">{error}</span>}
      {required ? (
        <span className={cn('flex items-start gap-1.5 text-[12px] leading-[1.45]', missing ? 'text-down' : 'text-warn')}>
          <IconWarn size={13} className="mt-0.5 shrink-0" />
          <span>
            {missing ? t('stellar.memoMissing') : t('stellar.memoCheck')}
            {t('stellar.memoWhy')}
          </span>
        </span>
      ) : empty ? (
        <span className="text-[12px] leading-[1.45] text-mute">{t('stellar.noMemo')}</span>
      ) : (
        <span className="text-[12px] text-mute">{t('stellar.memoPublic')}</span>
      )}
      {dest && !dest.exists && (
        <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-warn">
          <IconInfo size={13} className="mt-0.5 shrink-0" />
          <span>{t('stellar.destMissing')}</span>
        </span>
      )}
    </div>
  );
}

/** Spendable = balance − reserve, with the reserve explained. */
export function StellarSpendable({ account, hidden }: { account: StellarAccountInfo | undefined; hidden: boolean }) {
  useT();
  if (!account) return null;
  if (!account.exists) {
    return <span className="text-[12px] text-warn">{t('stellar.ownNotCreated')}</span>;
  }
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      {rt('stellar.spendable', { b: (c) => <strong className="font-semibold text-text2">{c}</strong> }, { spendable: hidden ? '•••••' : XLM(account.spendable), balance: hidden ? '•••••' : XLM(account.balance), reserve: XLM(account.reserve) })} <StellarReserveText account={account} />
    </span>
  );
}

/** The minimum balance in plain words: (2 + entries) × base reserve (+ offers). */
export function StellarReserveText({ account }: { account: StellarAccountInfo }) {
  const entries = 2 + account.subentryCount + account.numSponsoring - account.numSponsored;
  return (
    <>
      {t('stellar.reserve', { entries, base: XLM(account.baseReserve), count: account.subentryCount, offers: BigInt(account.sellingLiabilities) > 0n ? t('stellar.reserveOffers', { amount: XLM(account.sellingLiabilities) }) : '' })}
    </>
  );
}

const memoShown = (u: StellarUnsigned): { value: string; kind: string } | null => {
  const m = u.summary.memo;
  switch (m.kind) {
    case 'none':
      return null;
    case 'text':
      return { value: m.text ?? m.hex, kind: m.text === null ? t('stellar.mkBytes') : t('stellar.mkText') };
    case 'id':
      return { value: m.id, kind: t('stellar.mkId') };
    case 'hash':
      return { value: m.hex, kind: t('stellar.mkHash') };
    case 'return':
      return { value: m.hex, kind: t('stellar.mkReturn') };
  }
};

/** Rust's decoding, before the password: memo framed, account creation, fee, reserve, validity. */
export function StellarSummaryView({ u, xlmPrice, currency }: { u: StellarUnsigned; xlmPrice: number | null; currency: Currency }) {
  useT();
  const s = u.summary;
  const c = u.context;
  const memo = memoShown(u);
  const fiat = (st: string) => {
    const v = xlmPrice !== null ? (Number(BigInt(st)) / 1e7) * xlmPrice : 0;
    return v >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  const minutes = Math.max(0, Math.ceil((s.maxTime - c.ledgerTime) / 60));
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label={t('stellar.decodedLabel')}>
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">{u.createsAccount ? t('stellar.createTitle') : t('stellar.paymentTitle')}</span>
        <span className="text-[12px] text-mute">{t('stellar.decodedByVault')}</span>
      </div>
      <div className={cn('mx-3 my-2.5 rounded-ctl border-2 px-3 py-2 text-center', memo ? 'border-ice-line' : c.destination.memoRequired ? 'border-down/60' : 'border-warn/50')}>
        <span className="block text-[12px] font-medium text-mute">{t('stellar.memo')}{memo ? ` (${memo.kind})` : ''}</span>
        <span className={cn('block font-semibold break-all', memo ? 'font-mono text-text' : 'text-warn', memo && memo.value.length > 24 ? 'text-[12px]' : 'text-[18px]')}>{memo ? memo.value : t('stellar.memoNone')}</span>
      </div>
      {u.createsAccount && <Line k={t('stellar.lDest')} v={t('stellar.lDestCreated')} warn />}
      {s.operation.kind === 'payment' && s.operation.asset.kind === 'credit' && <Line k={t('stellar.lVerifiedIssuer')} v={`${s.operation.asset.code} · ${shortAddress(s.operation.asset.issuer)}`} />}
      <Line k={t('stellar.lFee')} v={t('stellar.lFeeValue', { fee: `${XLM(s.fee)}${fiat(s.fee)}`, base: c.baseFee })} />
      <Line k={t('stellar.lBalance')} v={XLM(c.account.balance)} />
      <Line k={t('stellar.lReserve')} v={`${XLM(c.account.reserve)} ((2 + ${c.account.subentryCount}) × ${XLM(c.baseReserve)})`} />
      <Line k={t('stellar.lSpendable')} v={XLM(c.account.spendable)} />
      <Line k={t('stellar.lValid')} v={t('stellar.lValidValue', { minutes, sequence: s.sequence })} />
      <Line k={t('stellar.lNetwork')} v={s.network === 'mainnet' ? 'Public Global Stellar Network' : 'Test SDF Network'} last />
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

type Status = { state: 'pending' } | { state: 'included' } | { state: 'failed' } | { state: 'error'; message: string };

/**
 * After `stellar_broadcast` (Horizon answers once the transaction is in a ledger): confirms it with
 * `stellar_tx_status`.
 */
export function StellarTxStatusLine({ adapter, hash, recipient, onIncluded }: { adapter: StellarAdapter; hash: string; recipient: string; onIncluded?: () => void }) {
  useT();
  const [status, setStatus] = useState<Status>({ state: 'pending' });
  useEffect(() => {
    let alive = true;
    let timer = 0;
    let tries = 0;
    const tick = async () => {
      try {
        const s = await adapter.txStatus(hash);
        if (!alive) return;
        if (s.found) {
          setStatus(s.successful ? { state: 'included' } : { state: 'failed' });
          if (s.successful) onIncluded?.();
          return;
        }
      } catch (e) {
        if (!alive) return;
        setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
      if (++tries < 30) timer = window.setTimeout(() => void tick(), 2_000);
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
        <Spinner /> {t('stellar.checking')}
      </div>
    );
  }
  if (status.state === 'included') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        {rt('stellar.included', { b: (c) => <strong className="font-semibold">{c}</strong> }, { recipient: shortAddress(recipient) })}
      </Notice>
    );
  }
  if (status.state === 'failed') {
    return (
      <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />} className="w-full text-left">
        {rt('stellar.failed', { b: (c) => <strong className="font-semibold">{c}</strong> })}
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      {t('stellar.trackError', { message: status.message })}
    </Notice>
  );
}
