// SPDX-License-Identifier: GPL-3.0-or-later
// Top of a staking screen, built like a coin page: the coin's light, the ring of what is staked
// (coin colour) against what is still available (ice), the staked amount, then the actions.

import { useMemo, type ReactNode } from 'react';
import { assetsFor, unitsToNumber } from '@kyro/chains';
import { useApp } from '../state/app';
import { usePortfolio } from '../state/portfolio';
import { fmtCrypto, fmtFiat } from '../lib/format';
import type { StakeChain } from '../lib/staking';
import { useT } from '../i18n';
import { CoinIcon, HIDDEN } from './kit';
import { Annotated, BIG, CoinGlow, GLASS_ROW, GLOW, IceSquare, LABEL, Side, THIN, type Note, type Seg } from './kyro';
import { coinTint, useWidth } from './kyroParts';
import { cn } from '../lib/cn';

const CHAIN_KEY: Record<StakeChain, string> = { sol: 'solana', ada: 'cardano', tron: 'tron', near: 'near', sui: 'sui', apt: 'aptos' };

export interface StakeHeroProps {
  chain: StakeChain;
  /** Staked (or delegated), base units. */
  staked: bigint;
  /** Still free on the address, base units. */
  available: bigint;
  decimals: number;
  symbol: string;
  /** Label of the coloured part (Staked, Delegated…). */
  stakedLabel: string;
  /** A short line under the value (rate, rewards), when there is one. */
  extra?: ReactNode;
  /** Frost main action first, then coin-lit ones. */
  actions: ReactNode;
}

/** The coin colour of a staking chain, for its lit buttons. */
export function useStakeColor(chain: StakeChain): string {
  const { network } = useApp();
  const asset = useMemo(() => assetsFor(network).find((a) => a.chainKey === CHAIN_KEY[chain] && a.kind === 'native'), [network, chain]);
  return coinTint(asset?.color);
}

export function StakeHero({ chain, staked, available, decimals, symbol, stakedLabel, extra, actions }: StakeHeroProps) {
  const { network, hideBalances, settings } = useApp();
  const pf = usePortfolio();
  const { t } = useT();
  const [stageRef, stageW] = useWidth<HTMLDivElement>();
  const asset = useMemo(() => assetsFor(network).find((a) => a.chainKey === CHAIN_KEY[chain] && a.kind === 'native'), [network, chain]);
  const c = coinTint(asset?.color);
  const price = asset ? pf.price(asset.coingeckoId)?.price : undefined;
  const fiat = (v: bigint) => (price !== undefined ? fmtFiat(unitsToNumber(v, decimals) * price, settings.currency) : null);
  const crypto = (v: bigint) => (hideBalances ? HIDDEN : fmtCrypto(v, decimals, symbol));
  const empty = staked <= 0n && available <= 0n;
  const segs: Seg[] = empty ? [{ color: '#cfe7ff', part: 1, ice: true }] : [{ color: asset?.color ?? '#7cc4ff', part: Number(staked) || 0 }, { color: '#cfe7ff', part: Number(available) || 0, ice: true }];
  const note = (seg: number, side: 'L' | 'R', title: string, v: bigint, lit: boolean): Note => ({
    seg,
    side,
    ...(lit ? { dot: c } : {}),
    node: (
      <Side side={side} icon={lit ? <span className="block size-[9px] rounded-[2px]" style={{ background: c, boxShadow: `0 0 8px ${c}` }} /> : <IceSquare size={10} />}>
        <span className="text-[13.5px] font-semibold">{title}</span>
        <span className="figure text-[12.5px] text-mute">
          <span style={lit && !hideBalances ? GLOW(c) : undefined}>{crypto(v)}</span>
          {fiat(v) !== null && <> · {hideBalances ? HIDDEN : fiat(v)}</>}
        </span>
      </Side>
    ),
  });
  const notes: Note[] = empty ? [] : [...(staked > 0n ? [note(0, 'L', stakedLabel, staked, true)] : []), ...(available > 0n ? [note(1, 'R', t('staking.available'), available, false)] : [])];
  const W = Math.min(1200, Math.max(stageW, 0));
  const total = fiat(staked);
  return (
    <section className="relative flex shrink-0 flex-col">
      <CoinGlow color={asset?.color ?? '#7cc4ff'} top={-60} width={980} height={440} />
      <div ref={stageRef} className="relative w-full">
        {W > 0 && (
          <Annotated W={W} H={250} size={210} segs={segs} notes={W >= 960 ? notes : []} halo={asset?.color ?? '#7cc4ff'}>
            <CoinIcon {...(asset ? { asset } : { symbol })} size={52} />
          </Annotated>
        )}
      </div>
      <div className="relative mt-3 flex flex-col items-center text-center">
        <h2 className={cn(LABEL, 'm-0')}>{t('staking.heroLabel', { chain: asset?.name ?? symbol })}</h2>
        <span className="mt-3 text-[46px] leading-none" style={{ ...THIN, ...(staked > 0n && !hideBalances ? BIG(c) : {}) }}>
          {hideBalances ? (
            HIDDEN
          ) : (
            <>
              {fmtCrypto(staked, decimals)}
              <span className="ml-3 text-[20px]">{symbol}</span>
            </>
          )}
        </span>
        <span className="figure mt-3 flex min-h-5 flex-wrap items-center justify-center gap-x-2 text-[13px] text-text2">
          {total !== null && <span>{hideBalances ? HIDDEN : total}</span>}
          {total !== null && extra ? <span className="text-faint">·</span> : null}
          {extra ? <span className="text-faint">{extra}</span> : null}
        </span>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">{actions}</div>
      </div>
    </section>
  );
}

/** A glass panel for the lists and forms below the hero. */
export function StakePanel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('overflow-hidden rounded-[20px]', GLASS_ROW, className)}>{children}</div>;
}
