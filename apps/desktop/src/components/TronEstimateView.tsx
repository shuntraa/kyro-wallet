// SPDX-License-Identifier: GPL-3.0-or-later
// TRON: Rust's resource estimate (tron_build_tx → TronEstimate), shown before the password.

import type { Currency } from '@kyro/shared';
import { isKnownTronToken, tronCoverage, type TronUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, fmtIntl, shortAddress } from '../lib/format';
import { useT } from '../i18n';
import { rt } from '../i18n/rich';
import { Notice } from './ui/primitives';
import { IconWarn } from './icons';

const TRX = (sun: bigint | string) => fmtCrypto(BigInt(sun), 6, 'TRX', 6);
const STANDARD_ACTIVATION = 1_100_000n;

export function TronEstimateView({ u, network, trxPrice, currency }: { u: TronUnsigned; network: 'mainnet' | 'testnet'; trxPrice: number | null; currency: Currency }) {
  const { t } = useT();
  const e = u.estimate;
  const isToken = !!u.token;
  const sent = isToken ? 0n : u.amount;
  const cov = tronCoverage(e, sent);
  const fiat = (sun: string | bigint) => (trxPrice !== null ? ` · ${fmtFiat((Number(BigInt(sun)) / 1e6) * trxPrice, currency)}` : '');
  const bwSource = e.stakedBandwidth >= e.bandwidthNeeded ? t('send.tronBwFrozen') : e.freeBandwidth >= e.bandwidthNeeded ? t('send.tronBwFree') : t('send.tronBwBurned');
  const activation = BigInt(e.activationFee);
  const unverified = isToken && u.token && !isKnownTronToken(network, u.token.contract);

  return (
    <div className="flex flex-col gap-3" aria-label={t('send.tronTitle')}>
      <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]">
        <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
          <span className="text-[12px] font-semibold text-text">{t('send.tronTitle')}</span>
          <span className="text-[11px] text-mute">{t('send.tronEstimatedByVault')}</span>
        </div>
        <Line
          k={t('send.tronBandwidth')}
          sub={t('send.tronBandwidthSub', { needed: e.bandwidthNeeded, free: e.freeBandwidth, staked: e.stakedBandwidth })}
          v={BigInt(e.bandwidthBurn) > 0n ? t('send.tronBurned', { amount: TRX(e.bandwidthBurn) }) : activation > 0n ? t('send.tronInActivation') : t('send.tronZeroVia', { source: bwSource })}
        />
        {isToken && (
          <>
            <Line k={t('send.tronEnergy')} sub={t('send.tronEnergySub', { needed: fmtIntl(e.energyNeeded), available: fmtIntl(e.energyAvailable), fee: e.energyFee })} v={t('send.tronEnergyBurn', { amount: TRX(e.energyBurn) })} />
            <Line k={t('send.tronFeeLimit')} sub={t('send.tronFeeLimitSub')} v={t('send.maxSuffix', { amount: TRX(e.feeLimit) })} />
          </>
        )}
        {!e.recipientExists && (
          <Line
            k={t('send.tronActivation')}
            sub={activation === STANDARD_ACTIVATION ? t('send.tronActivationStd') : t('send.tronActivationOther')}
            v={t('send.tronBurned', { amount: TRX(activation) })}
            warn
          />
        )}
        <Line k={t('send.tronTotalBurned')} sub={t('send.tronTotalBurnedSub')} v={`${TRX(e.totalBurn)} · ${TRX(e.totalBurnMax)}`} strong />
        <Line k={t('send.tronYourBalance')} v={`${TRX(e.balance)}${fiat(e.balance)}`} last />
      </div>

      {unverified && u.token && (
        <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
          {rt('send.tronUnverified', { b: (c) => <strong className="font-semibold">{c}</strong> }, { raw: <span className="font-mono">{u.amount.toString()}</span>, contract: shortAddress(u.token.contract), symbol: u.token.symbol, decimals: u.token.decimals })}
        </Notice>
      )}

      {!cov.expected ? (
        <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />}>
          <strong className="font-semibold">{t('send.tronInsufficientTitle')}</strong>{' '}
          {isToken
            ? t('send.tronInsufficientToken', { need: TRX(e.totalBurn), have: TRX(e.balance), missing: TRX(cov.missing) })
            : t('send.tronInsufficientTrx', { need: TRX(sent + BigInt(e.totalBurn)), have: TRX(e.balance), missing: TRX(cov.missing) })}{' '}
          {isToken ? t('send.tronBlockedToken') : t('send.tronBlocked')}
        </Notice>
      ) : !cov.worst ? (
        <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
          {t('send.tronWorstNotCovered', { max: TRX(e.totalBurnMax), missing: TRX(cov.missingWorst) })}
        </Notice>
      ) : null}
    </div>
  );
}

function Line({ k, sub, v, warn, strong, last }: { k: string; sub?: string; v: string; warn?: boolean; strong?: boolean; last?: boolean }) {
  return (
    <div className={`flex items-start justify-between gap-3 px-3.5 py-2 ${last ? '' : 'border-b border-line'}`}>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={strong ? 'font-semibold text-text' : 'text-text2'}>{k}</span>
        {sub && <span className="text-[11px] leading-[1.4] text-mute">{sub}</span>}
      </span>
      <span className={`shrink-0 text-right ${warn ? 'text-warn' : strong ? 'font-semibold text-text' : 'text-text2'}`}>{v}</span>
    </div>
  );
}
