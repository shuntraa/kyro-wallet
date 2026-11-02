// SPDX-License-Identifier: GPL-3.0-or-later
// Sui pieces of the Send screen (docs/IPC.md §2.11): - the full-address rule (0x + 64 hex, no
// checksum on Sui: compare it entirely); - spendable = SUI held in coin objects (the address
// balance is shown, not spent); - the Rust-decoded transfer before the password (gas budget /
// price, simulated fee, epoch); - the execution follow-up (sui_tx_status).

import { useEffect, useState } from 'react';
import type { Currency, SuiBalance } from '@kyro/shared';
import type { SuiAdapter, SuiUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice, Spinner } from './ui/primitives';
import { IconCheck, IconWarn } from './icons';
import { cn } from '../lib/cn';
import { t, useT } from '../i18n';
import { rt } from '../i18n/rich';

const SUI = (mist: bigint | string) => fmtCrypto(BigInt(mist), 9, 'SUI', 9);

/** Coins vs address balance, with the reason Kyro spends only the former. Token: gas is paid in SUI. */
export function SuiSpendable({ balance, hidden, token }: { balance: SuiBalance | undefined; hidden: boolean; token?: boolean }) {
  useT();
  if (token) return <span className="text-[12px] leading-[1.45] text-mute">{t('sui.gasInSui')}</span>;
  if (!balance) return null;
  const ab = BigInt(balance.addressBalance);
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      {rt('sui.spendable', { b: (c) => <strong className="font-semibold text-text2">{c}</strong> }, { spendable: hidden ? '•••••' : SUI(balance.coin) })}
      {ab > 0n ? t('sui.addressBalance', { amount: hidden ? '•••••' : SUI(ab) }) : ''} {t('sui.gasOnTop')}
    </span>
  );
}

/** Rust's decoding, before the password. */
export function SuiSummaryView({ u, suiPrice, currency }: { u: SuiUnsigned; suiPrice: number | null; currency: Currency }) {
  useT();
  const s = u.summary;
  const c = u.context;
  const fiat = (mist: string) => {
    const v = suiPrice !== null ? (Number(BigInt(mist)) / 1e9) * suiPrice : 0;
    return Math.abs(v) >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  const fee = BigInt(c.fee);
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label={t('sui.decodedLabel')}>
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">{t('sui.title')}</span>
        <span className="text-[12px] text-mute">{t('sui.decodedByVault')}</span>
      </div>
      {s.token ? (
        <>
          <Line k={t('sui.lToken')} v={t('sui.lTokenValue', { symbol: s.token.symbol, decimals: s.token.decimals })} />
          <Line k={t('sui.lCoinType')} v={s.token.coinType} mono />
          <Line k={t('sui.lAmount')} v={s.amount !== null ? fmtCrypto(BigInt(s.amount), s.token.decimals, s.token.symbol, s.token.decimals) : t('sui.allToken', { symbol: s.token.symbol, amount: fmtCrypto(BigInt(c.token?.coinsTotal ?? '0'), s.token.decimals, s.token.symbol, s.token.decimals) })} warn={s.amount === null} />
          <Line k={t('sui.lTokenCoins', { symbol: s.token.symbol })} v={`${s.token.coins.length}`} />
        </>
      ) : (
        <>
          <Line k={t('sui.lToken')} v={`SUI (${s.coinType})`} />
          <Line k={t('sui.lAmount')} v={s.amount !== null ? SUI(s.amount) : t('sui.allCoins', { receives: c.receives ? t('sui.receives', { amount: SUI(c.receives) }) : '' })} warn={s.amount === null} />
        </>
      )}
      <Line k={t('sui.lFeeSim')} v={`${fee < 0n ? '−' : ''}${SUI(fee < 0n ? -fee : fee)}${fiat(c.fee)}`} />
      <Line k={t('sui.lGasBudget')} v={`${SUI(s.gasBudget)}${fiat(s.gasBudget)}`} />
      <Line k={t('sui.lGasPrice')} v={t('sui.lGasPriceValue', { price: s.gasPrice, reference: c.referenceGasPrice })} />
      <Line k={t('sui.lGasCoins')} v={`${s.gasCoins.length} · ${SUI(c.gasCoinsTotal)}`} />
      {s.gasCoins.slice(0, 5).map((g, i) => (
        <Line key={g.objectId} k={`· ${shortAddress(g.objectId)} v${g.version}`} v={c.gasCoinBalances[i] !== undefined ? SUI(c.gasCoinBalances[i]) : '?'} mono />
      ))}
      {s.gasCoins.length > 5 && <Line k={t('sui.otherCoins', { count: s.gasCoins.length - 5 })} v={SUI(c.gasCoinBalances.slice(5).reduce((a, b) => a + BigInt(b), 0n))} />}
      <Line k={t('sui.lValidEpoch')} v={s.expirationEpoch !== null ? t('sui.lValidEpochValue', { epoch: s.expirationEpoch, current: c.epoch }) : t('sui.noLimit')} warn={s.expirationEpoch === null} />
      <Line k={t('sui.lDigest')} v={shortAddress(s.digest)} last />
    </div>
  );
}

function Line({ k, v, warn, last, mono }: { k: string; v: string; warn?: boolean; last?: boolean; mono?: boolean }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-3.5 py-1.5', !last && 'border-b border-line')}>
      <span className={cn('text-text2', mono && 'pl-2 font-mono text-[12px] text-mute')}>{k}</span>
      <span className={cn('text-right', warn ? 'text-warn' : 'text-text2')}>{v}</span>
    </div>
  );
}

type Status = { state: 'pending' } | { state: 'done' } | { state: 'failed'; error: string } | { state: 'slow' } | { state: 'error'; message: string };

/** After `sui_broadcast` (already final): follows `sui_tx_status` until the indexer has it. */
export function SuiTxStatusLine({ adapter, digest, recipient, onIndexed }: { adapter: SuiAdapter; digest: string; recipient: string; onIndexed?: () => void }) {
  useT();
  const [status, setStatus] = useState<Status>({ state: 'pending' });
  useEffect(() => {
    let alive = true;
    const started = Date.now();
    let timer = 0;
    const tick = async () => {
      try {
        const s = await adapter.txStatus(digest);
        if (!alive) return;
        if (s.found) {
          if (s.success) {
            setStatus({ state: 'done' });
            onIndexed?.();
          } else setStatus({ state: 'failed', error: s.error ?? t('sui.unknown') });
          return;
        }
        if (Date.now() - started > 60_000) {
          setStatus({ state: 'slow' });
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
  }, [adapter, digest]);

  if (status.state === 'pending') {
    return (
      <div role="status" className="flex w-full items-center gap-2 rounded-ctl border border-line bg-raised px-3.5 py-2.5 text-[13px] text-text2">
        <Spinner /> {t('sui.pending')}
      </div>
    );
  }
  if (status.state === 'done') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        {rt('sui.done', { b: (c) => <strong className="font-semibold">{c}</strong> }, { recipient: shortAddress(recipient) })}
      </Notice>
    );
  }
  if (status.state === 'failed') {
    return (
      <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />} className="w-full text-left">
        {rt('sui.failed', { b: (c) => <strong className="font-semibold">{c}</strong> }, { error: status.error })}
      </Notice>
    );
  }
  if (status.state === 'slow') {
    return (
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
        {t('sui.slow')}
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      {t('sui.trackError', { message: status.message })}
    </Notice>
  );
}
