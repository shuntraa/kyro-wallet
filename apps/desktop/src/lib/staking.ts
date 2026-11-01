// SPDX-License-Identifier: GPL-3.0-or-later
//
// Staking (docs/IPC.md §2.8): pure helpers for the screens — labels, warning texts that match
// Rust's reinforced-dialog triggers, picker sorting and badges. Nothing here builds or edits a
// transaction: Rust does that (`*_stake_build`), the UI only chooses an operation.

import type { AdaPool, AdaStakeWarning, Network, SolStakeState, SolStakeWarning, SolValidator, TronStakeWarning, TronWitness } from '@kyro/shared';
import { fmtCrypto, fmtNumber, shortAddress } from './format';
import { t } from '../i18n';

export type StakeChain = 'sol' | 'ada' | 'tron';

/** Rust thresholds (reinforced 2nd dialog). */
export const SOL_HIGH_COMMISSION = 10;
export const ADA_HIGH_MARGIN = 0.1;
export const ADA_SATURATED = 100;
export const TRON_PAID_RANKS = 127;

export function networkLabel(chain: StakeChain, network: Network): string {
  if (network === 'mainnet') return 'mainnet';
  return { sol: 'devnet', ada: 'preprod', tron: 'Nile' }[chain];
}

export function solStateLabel(s: SolStakeState): string {
  switch (s) {
    case 'initialized':
      return t('staking.solStateInitialized');
    case 'activating':
      return t('staking.solStateActivating');
    case 'active':
      return t('staking.solStateActive');
    case 'deactivating':
      return t('staking.solStateDeactivating');
    case 'inactive':
      return t('staking.solStateInactive');
  }
}
export function solStateTone(s: SolStakeState): 'up' | 'ice' | 'warn' | 'mute' {
  return s === 'active' ? 'up' : s === 'activating' ? 'ice' : s === 'deactivating' ? 'warn' : 'mute';
}

/** "≈ 1 j 4 h", "≈ 3 h 12 min", "≈ 8 min" (EN: "≈ 1 d 4 h"). */
export function fmtDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h ? t('staking.durDaysHours', { d, h }) : t('staking.durDays', { d });
  if (h > 0) return `≈ ${h} h${m ? ` ${m} min` : ''}`;
  return s < 60 ? '< 1 min' : `≈ ${m} min`;
}

// ------------------------------------------------------------------ warnings (same triggers as Rust)

export function solValidatorBadges(v: SolValidator): { tone: 'down' | 'warn'; text: string }[] {
  const out: { tone: 'down' | 'warn'; text: string }[] = [];
  if (v.delinquent) out.push({ tone: 'down', text: t('staking.badgeDelinquent') });
  if (v.commission > SOL_HIGH_COMMISSION) out.push({ tone: 'warn', text: t('staking.badgeCommission', { pct: v.commission }) });
  return out;
}
export function solWarningText(w: SolStakeWarning): string {
  return w.kind === 'delinquent'
    ? t('staking.warnSolDelinquent')
    : t('staking.warnSolCommission', { pct: w.commission });
}

export function adaPoolBadges(p: AdaPool): { tone: 'down' | 'warn'; text: string }[] {
  const out: { tone: 'down' | 'warn'; text: string }[] = [];
  if (p.status === 'retired') out.push({ tone: 'down', text: t('staking.badgeRetired') });
  if (p.status === 'retiring') out.push({ tone: 'down', text: p.retiringEpoch !== null ? t('staking.badgeRetiringAt', { epoch: p.retiringEpoch }) : t('staking.badgeRetiring') });
  if (p.margin > ADA_HIGH_MARGIN) out.push({ tone: 'warn', text: t('staking.badgeMargin', { pct: fmtNumber(p.margin * 100, 1) }) });
  if ((p.liveSaturation ?? 0) > ADA_SATURATED) out.push({ tone: 'warn', text: t('staking.badgeSaturated', { pct: fmtNumber(p.liveSaturation ?? 0, 1) }) });
  return out;
}
export function adaWarningText(w: AdaStakeWarning): string {
  switch (w.kind) {
    case 'poolRetiring':
      return t('staking.warnAdaRetiring', { epoch: w.epoch });
    case 'highMargin':
      return t('staking.warnAdaMargin', { pct: fmtNumber(w.margin, 1) });
    case 'poolSaturated':
      return t('staking.warnAdaSaturated', { pct: fmtNumber(w.saturation, 1) });
    case 'drepInactive':
      return t('staking.warnAdaDrepInactive');
  }
}

export function tronWitnessBadges(w: TronWitness): { tone: 'down' | 'warn' | 'ice'; text: string }[] {
  const out: { tone: 'down' | 'warn' | 'ice'; text: string }[] = [];
  if (w.isSr) out.push({ tone: 'ice', text: 'SR' });
  if (w.rank > TRON_PAID_RANKS || !w.isPaid) out.push({ tone: 'down', text: t('staking.badgeNotPaid') });
  if (w.brokerage !== null && w.brokerage >= 100) out.push({ tone: 'down', text: t('staking.badgeKeepsAll') });
  return out;
}
export function tronWarningText(w: TronStakeWarning, witnesses: TronWitness[] = []): string {
  const label = (a: string) => witnesses.find((x) => x.address === a)?.url ?? shortAddress(a);
  switch (w.kind) {
    case 'srNotPaid':
      return t('staking.warnTronNotPaid', { sr: label(w.address), rank: w.rank });
    case 'brokerageAll':
      return t('staking.warnTronBrokerage', { sr: label(w.address) });
    case 'votesReduced':
      return t('staking.warnTronVotesReduced');
  }
}

// ------------------------------------------------------------------ pickers

export type SolSort = 'commission' | 'stake';
export function sortValidators(list: SolValidator[], by: SolSort): SolValidator[] {
  const out = [...list];
  // Delinquent ones always last: they earn nothing.
  out.sort((a, b) => Number(a.delinquent) - Number(b.delinquent) || (by === 'commission' ? a.commission - b.commission || cmpBig(b.activatedStake, a.activatedStake) : cmpBig(b.activatedStake, a.activatedStake)));
  return out;
}

export type AdaSort = 'margin' | 'saturation' | 'stake';
export function sortPools(list: AdaPool[], by: AdaSort): AdaPool[] {
  const out = [...list];
  const bad = (p: AdaPool) => Number(p.status !== 'registered');
  out.sort((a, b) => {
    const d = bad(a) - bad(b);
    if (d) return d;
    if (by === 'margin') return a.margin - b.margin || cmpBig(a.fixedCost, b.fixedCost);
    if (by === 'saturation') return (a.liveSaturation ?? Infinity) - (b.liveSaturation ?? Infinity);
    return cmpBig(b.liveStake ?? '0', a.liveStake ?? '0');
  });
  return out;
}

export type TronSort = 'rank' | 'votes';
export function sortWitnesses(list: TronWitness[], by: TronSort): TronWitness[] {
  const out = [...list];
  out.sort((a, b) => (by === 'rank' ? a.rank - b.rank : b.voteCount - a.voteCount));
  return out;
}

function cmpBig(a: string, b: string): number {
  const x = BigInt(a || '0');
  const y = BigInt(b || '0');
  return x < y ? -1 : x > y ? 1 : 0;
}

/** "2 500 000 SOL" style compact stake. */
export function fmtStake(amount: string | null, decimals: number, symbol: string): string {
  if (amount === null) return '—';
  return fmtCrypto(BigInt(amount), decimals, symbol, 0);
}

// ------------------------------------------------------------------ Cardano DRep

export type DrepMode = 'alwaysAbstain' | 'alwaysNoConfidence' | 'custom';
/** The `drep` argument of `ada_stake_*` for a choice (null: invalid custom id). */
export function drepArg(mode: DrepMode, custom: string): string | null {
  if (mode !== 'custom') return mode;
  const id = custom.trim();
  return /^drep(_script)?1[0-9a-z]{20,}$/.test(id) ? id : null;
}
export function drepLabel(drep: string | null): string {
  if (drep === null) return t('staking.drepNone');
  if (drep === 'alwaysAbstain') return t('staking.drepAbstain');
  if (drep === 'alwaysNoConfidence') return t('staking.drepNoConfidence');
  return shortAddress(drep, 10, 6);
}

// ------------------------------------------------------------------ TRON votes

/** Votes typed per SR → the request list (counts > 0) and the total; null when a count is not an integer. */
export function tronVotes(counts: Record<string, string>): { votes: { address: string; count: string }[]; total: number } | null {
  const votes: { address: string; count: string }[] = [];
  let total = 0;
  for (const [address, raw] of Object.entries(counts)) {
    const t = raw.trim();
    if (t === '' || t === '0') continue;
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    votes.push({ address, count: String(n) });
    total += n;
  }
  return { votes, total };
}
