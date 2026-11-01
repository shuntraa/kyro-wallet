// SPDX-License-Identifier: GPL-3.0-or-later
// Cosmos Hub pieces of the Send screen (docs/IPC.md §2.11):
// - the memo field, ALWAYS visible right under the recipient (exchanges identify deposits by it);
// - the Rust-decoded transaction before the password (chain id, gas, fee, memo, validity);
// - the inclusion follow-up (cosmos_tx_status).

import { useEffect, useState } from 'react';
import type { CosmosAccountInfo, Currency } from '@kyro/shared';
import { cosmosMemoProblem, type CosmosAdapter, type CosmosUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice, Spinner } from './ui/primitives';
import { IconCheck, IconWarn } from './icons';
import { cn } from '../lib/cn';
import { locale, t, useT } from '../i18n';
import { rt } from '../i18n/rich';
import { cosmos as cosmosFr } from '../i18n/fr/cosmos';

const ATOM = (uatom: bigint | string) => fmtCrypto(BigInt(uatom), 6, 'ATOM', 6);

/** The exchange-deposit hint, shown while the memo is empty: its French wording (the UI shows `t('cosmos.exchangeHint')`). */
export const EXCHANGE_MEMO_HINT: string = cosmosFr['cosmos.exchangeHint'];

export function CosmosMemoField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  useT();
  const problem = cosmosMemoProblem(value);
  return (
    <div className={cn('flex flex-col gap-2 rounded-box border px-4 py-3.5', problem ? 'border-down/60 bg-down/[.05]' : 'border-ice-line bg-ice/[.05]')}>
      <label htmlFor="cosmos-memo" className="text-[13px] font-semibold text-text">
        {t('cosmos.memo')} <span className="font-normal text-mute">{t('cosmos.memoHint')}</span>
      </label>
      <input
        id="cosmos-memo"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={t('cosmos.memoPlaceholder')}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!problem}
        className="h-11 rounded-ctl border border-line-3 bg-bg px-3 font-mono text-[15px] font-semibold text-text focus:border-ice-line"
      />
      {problem ? (
        <span className="text-[12px] text-down">{problem}</span>
      ) : value.trim() === '' ? (
        <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-mute">
          <IconWarn size={13} className="mt-0.5 shrink-0 text-warn" />
          <span>{t('cosmos.noMemo', { hint: t('cosmos.exchangeHint') })}</span>
        </span>
      ) : (
        <span className="text-[12px] text-mute">{t('cosmos.memoCopy')}</span>
      )}
    </div>
  );
}

/** What can be sent now (vesting accounts: less than the balance). */
export function CosmosSpendable({ account, hidden }: { account: CosmosAccountInfo | undefined; hidden: boolean }) {
  useT();
  if (!account) return null;
  if (!account.exists) return <span className="text-[12px] text-warn">{t('cosmos.ownMissing')}</span>;
  if (account.spendable === account.balance) return null;
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      {rt('cosmos.spendable', { b: (c) => <strong className="font-semibold text-text2">{c}</strong> }, { spendable: hidden ? '•••••' : ATOM(account.spendable), balance: hidden ? '•••••' : ATOM(account.balance) })}
    </span>
  );
}

/** Rust's decoding of the SignDoc, before the password. */
export function CosmosSummaryView({ u, atomPrice, currency }: { u: CosmosUnsigned; atomPrice: number | null; currency: Currency }) {
  useT();
  const s = u.summary;
  const fiat = (d: string) => {
    const v = atomPrice !== null ? (Number(BigInt(d)) / 1e6) * atomPrice : 0;
    return v >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  const minutes = Math.max(1, Math.ceil(((s.timeoutHeight - u.context.height) * 6) / 60));
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label={t('cosmos.decodedLabel')}>
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">MsgSend Cosmos Hub</span>
        <span className="text-[11px] text-mute">{t('cosmos.decodedByVault')}</span>
      </div>
      <div className={cn('mx-3 my-2.5 rounded-ctl border-2 px-3 py-2 text-center', s.memo !== null ? 'border-ice-line' : 'border-warn/50')}>
        <span className="block text-[12px] font-medium text-mute">{t('cosmos.memo')}</span>
        <span className={cn('block font-mono text-[16px] font-semibold break-all', s.memo !== null ? 'text-text' : 'text-warn')}>{s.memo ?? t('cosmos.memoNone')}</span>
      </div>
      <Line k={t('cosmos.lFee')} v={`${ATOM(s.fee)}${fiat(s.fee)}`} />
      <Line k={t('cosmos.lGas')} v={t('cosmos.lGasValue', { gas: s.gasLimit.toLocaleString(locale()) })} />
      <Line k={t('cosmos.lChainId')} v={s.chainId} />
      <Line k={t('cosmos.lAccountSeq')} v={t('cosmos.lAccountSeqValue', { account: s.accountNumber, sequence: s.sequence })} />
      <Line k={t('cosmos.lValidUntil')} v={t('cosmos.lValidUntilValue', { height: s.timeoutHeight, minutes })} last />
    </div>
  );
}

function Line({ k, v, last }: { k: string; v: string; last?: boolean }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-3.5 py-1.5', !last && 'border-b border-line')}>
      <span className="text-text2">{k}</span>
      <span className="text-right text-text2">{v}</span>
    </div>
  );
}

type Status = { state: 'pending' } | { state: 'included' } | { state: 'failed'; code: number | null; log: string } | { state: 'expired' } | { state: 'error'; message: string };

/**
 * After `cosmos_broadcast`: follows `cosmos_tx_status` until the transaction is in a block.
 * Code 0 → « incluse »; any other code → « échouée » (the fee is still taken). Not found after its
 * timeout height (≈ 10 min) + margin → it can no longer be included.
 */
export function CosmosTxStatusLine({ adapter, hash, recipient, onIncluded }: { adapter: CosmosAdapter; hash: string; recipient: string; onIncluded?: () => void }) {
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
        if (s.included) {
          if (s.success) {
            setStatus({ state: 'included' });
            onIncluded?.();
          } else setStatus({ state: 'failed', code: s.code, log: s.log });
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
      timer = window.setTimeout(() => void tick(), 3_000);
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
        <Spinner /> {t('cosmos.pending')}
      </div>
    );
  }
  if (status.state === 'included') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        {rt('cosmos.included', { b: (c) => <strong className="font-semibold">{c}</strong> }, { recipient: shortAddress(recipient) })}
      </Notice>
    );
  }
  if (status.state === 'failed') {
    return (
      <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />} className="w-full text-left">
        {rt('cosmos.failed', { b: (c) => <strong className="font-semibold">{c}</strong> }, { code: status.code ?? '?', log: status.log ? ` (${status.log})` : '' })}
      </Notice>
    );
  }
  if (status.state === 'expired') {
    return (
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
        {t('cosmos.expired')}
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      {t('cosmos.trackError', { message: status.message })}
    </Notice>
  );
}
