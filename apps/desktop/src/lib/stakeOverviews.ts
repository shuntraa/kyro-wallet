// SPDX-License-Identifier: GPL-3.0-or-later
// The six staking overviews of the wallet in use, shared by the Staking home and Earn. Same cache
// keys in both: the second screen shows the first one's answer at once.

import { call } from '@kyro/shared';
import { useApp, useVault } from '../state/app';
import { useOnTorReady } from '../state/tor';
import { fingerprint } from './balanceCache';
import type { StakeChain } from './staking';
import { useCachedAsync } from './useAsync';

export function useStakeAccount(): (chain: StakeChain) => { account?: number } {
  const { selectedAccounts } = useApp();
  return (chain) => (selectedAccounts[chain] ? { account: selectedAccounts[chain] } : {});
}

/**
 * Cache key of a staking read (network, command, account): the screen shows the last answer at
 * once and refreshes in the background (`useCachedAsync`).
 */
export function useStakeKey(): (cmd: string, args?: { account?: number }) => string {
  const { network, activeHw } = useApp();
  return (cmd, args) => `stake.${network}.${cmd}.${activeHw?.id ?? args?.account ?? 0}`;
}

/** Persisted per wallet (address fingerprint): last launch's answer at once, then a refresh. */
export function useStakeOverviews(refused: (c: StakeChain) => boolean, has: Record<StakeChain, boolean>) {
  const { activeHw } = useApp();
  const acct = useStakeAccount();
  const stakeKey = useStakeKey();
  const { accounts } = useVault();
  const addr: Partial<Record<StakeChain, string>> = { sol: accounts.sol?.address ?? '', ada: accounts.cardano?.address ?? '', tron: accounts.tron?.address ?? '', near: accounts.near?.address ?? '', sui: accounts.sui?.address ?? '', apt: accounts.aptos?.address ?? '' };
  const sk = (cmd: string, c: StakeChain) => `${stakeKey(cmd, acct(c))}.${fingerprint(addr[c] ?? '')}`;
  const p = { persist: true };
  const sol = useCachedAsync(sk('sol_stake_overview', 'sol'), !refused('sol') && has.sol ? () => (activeHw ? call('hw_sol_stake_overview', { accountId: activeHw.id }) : call('sol_stake_overview', acct('sol'))) : null, [activeHw?.id, has.sol, acct('sol').account], p);
  const ada = useCachedAsync(sk('ada_stake_overview', 'ada'), !refused('ada') && has.ada ? () => (activeHw ? call('hw_ada_stake_overview', { accountId: activeHw.id }) : call('ada_stake_overview', acct('ada'))) : null, [activeHw?.id, has.ada, acct('ada').account], p);
  const tron = useCachedAsync(sk('tron_stake_overview', 'tron'), !refused('tron') && has.tron ? () => call('tron_stake_overview', acct('tron')) : null, [activeHw?.id, has.tron, acct('tron').account], p);
  const near = useCachedAsync(sk('near_stake_overview', 'near'), !refused('near') && has.near ? () => (activeHw ? call('hw_near_stake_overview', { accountId: activeHw.id }) : call('near_stake_overview', acct('near'))) : null, [activeHw?.id, has.near, acct('near').account], p);
  const sui = useCachedAsync(sk('sui_stake_overview', 'sui'), !refused('sui') && has.sui ? () => call('sui_stake_overview', acct('sui')) : null, [activeHw?.id, has.sui, acct('sui').account], p);
  const aptos = useCachedAsync(sk('aptos_stake_overview', 'apt'), !refused('apt') && has.apt ? () => call('aptos_stake_overview', acct('apt')) : null, [activeHw?.id, has.apt, acct('apt').account], p);
  useOnTorReady(() => {
    sol.reload();
    ada.reload();
    tron.reload();
    near.reload();
    sui.reload();
    aptos.reload();
  });
  const sum = <T,>(list: T[] | undefined, of: (x: T) => string) => list?.reduce((s, x) => s + BigInt(of(x)), 0n);
  return {
    sol,
    ada,
    tron,
    near,
    sui,
    aptos,
    /** Staked amounts in base units; `undefined` until the first answer. */
    staked: {
      sol: sum(sol.data?.accounts, (a) => a.lamports),
      tron: tron.data ? BigInt(tron.data.stakedBandwidth) + BigInt(tron.data.stakedEnergy) : undefined,
      near: sum(near.data?.positions, (x) => x.staked),
      sui: sum(sui.data?.positions, (x) => x.principal),
      apt: sum(aptos.data?.positions, (x) => x.active),
    },
  };
}
