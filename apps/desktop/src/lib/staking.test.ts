import { describe, expect, it } from 'vitest';
import type { AdaPool, SolValidator, TronWitness } from '@kyro/shared';
import { adaPoolBadges, drepArg, drepLabel, fmtDuration, solValidatorBadges, sortPools, sortValidators, sortWitnesses, tronVotes, tronWitnessBadges } from './staking';

const v = (voteAccount: string, commission: number, stake: string, delinquent = false): SolValidator => ({ voteAccount, identity: voteAccount, name: null, commission, activatedStake: stake, delinquent, lastVote: 0, epochVoteAccount: !delinquent });
const p = (poolId: string, margin: number, saturation: number, status = 'registered'): AdaPool => ({
  poolId,
  poolHash: poolId,
  ticker: poolId,
  name: null,
  homepage: null,
  margin,
  fixedCost: '170000000',
  pledge: '0',
  activeStake: null,
  liveStake: String(saturation * 1000),
  liveSaturation: saturation,
  liveDelegators: 1,
  status,
  retiringEpoch: status === 'retiring' ? 240 : null,
});
const w = (rank: number, voteCount: number, brokerage: number | null = null): TronWitness => ({ address: `T${rank}`, url: `https://sr${rank}`, voteCount, rank, isSr: rank <= 27, isPaid: rank <= 127, producing: rank <= 27, brokerage });

describe('staking helpers', () => {
  it('badges follow the reinforced triggers (strictly above 10 %, saturation > 100 %, rank > 127)', () => {
    expect(solValidatorBadges(v('a', 10, '1'))).toEqual([]);
    expect(solValidatorBadges(v('a', 11, '1', true)).map((b) => b.text)).toEqual(['En retard', 'Commission 11 %']);
    expect(adaPoolBadges(p('x', 0.1, 100))).toEqual([]);
    expect(adaPoolBadges(p('x', 0.15, 104.7, 'retiring')).map((b) => b.tone)).toEqual(['down', 'warn', 'warn']);
    expect(tronWitnessBadges(w(127, 1)).some((b) => b.tone === 'down')).toBe(false);
    expect(tronWitnessBadges(w(128, 1)).some((b) => b.text.includes('aucune récompense'))).toBe(true);
    expect(tronWitnessBadges(w(3, 1, 100)).some((b) => b.text === 'Garde 100 %')).toBe(true);
  });

  it('sorting: delinquent / non-registered last, then by the chosen column', () => {
    const vs = [v('big', 8, '900'), v('late', 0, '9999', true), v('cheap', 0, '100')];
    expect(sortValidators(vs, 'commission').map((x) => x.voteAccount)).toEqual(['cheap', 'big', 'late']);
    expect(sortValidators(vs, 'stake').map((x) => x.voteAccount)).toEqual(['big', 'cheap', 'late']);
    const ps = [p('a', 0.02, 80), p('b', 0.01, 20, 'retiring'), p('c', 0.05, 10)];
    expect(sortPools(ps, 'margin').map((x) => x.poolId)).toEqual(['a', 'c', 'b']);
    expect(sortPools(ps, 'saturation').map((x) => x.poolId)).toEqual(['c', 'a', 'b']);
    expect(sortPools(ps, 'stake').map((x) => x.poolId)).toEqual(['a', 'c', 'b']);
    expect(sortWitnesses([w(2, 5), w(1, 3)], 'rank').map((x) => x.rank)).toEqual([1, 2]);
    expect(sortWitnesses([w(2, 5), w(1, 3)], 'votes').map((x) => x.rank)).toEqual([2, 1]);
  });

  it('DRep choice and TRON vote parsing', () => {
    expect(drepArg('alwaysAbstain', '')).toBe('alwaysAbstain');
    expect(drepArg('custom', ' drep1ytdemoactive0q8v9z5kq3f0xw ')).toBe('drep1ytdemoactive0q8v9z5kq3f0xw');
    expect(drepArg('custom', 'pool1abc')).toBeNull();
    expect(drepLabel(null)).toBe('Aucune délégation de vote');
    expect(drepLabel('alwaysAbstain')).toBe('Toujours s’abstenir');
    expect(tronVotes({ T1: '5', T2: '', T3: '0', T4: '12' })).toEqual({ votes: [{ address: 'T1', count: '5' }, { address: 'T4', count: '12' }], total: 17 });
    expect(tronVotes({ T1: '1,5' })).toBeNull();
  });

  it('durations', () => {
    expect(fmtDuration(30)).toBe('< 1 min');
    expect(fmtDuration(8 * 60)).toBe('≈ 8 min');
    expect(fmtDuration(3 * 3600 + 12 * 60)).toBe('≈ 3 h 12 min');
    expect(fmtDuration(86_400 + 4 * 3600)).toBe('≈ 1 j 4 h');
  });
});
