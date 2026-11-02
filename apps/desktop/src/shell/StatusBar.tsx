// SPDX-License-Identifier: GPL-3.0-or-later
// Status bar (30 px): sync state, Tor state, TESTNET / demo badges. Per-chain latencies live in
// Settings › Networks (NetDiagnostics).

import { useEffect, useState, type ReactNode } from 'react';
import { bitcoinServerFor } from '@kyro/shared';
import { useApp } from '../state/app';
import { useCbf } from '../state/cbf';
import { torWaiting, useTor } from '../state/tor';
import { TorIndicator } from '../components/Tor';
import { useT } from '../i18n';

export function StatusFrame({ left, right }: { left: ReactNode; right?: ReactNode }) {
  const { network, demo } = useApp();
  const { t } = useT();
  return (
    <footer className="flex h-[30px] shrink-0 items-center justify-between gap-2 border-t border-rail bg-bg-deep/80 px-4 text-[12px] text-mute">
      <div className="flex min-w-0 items-center gap-[18px] overflow-hidden pr-6 whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]">{left}</div>
      <div className="flex shrink-0 items-center gap-3">
        {right}
        {demo && <span className="rounded-full border border-ice/30 px-2 py-[3px] leading-none font-medium text-ice">{t('shell.demoMode')}</span>}
        {network === 'testnet' && <span className="rounded-full border border-warn/40 bg-warn/[.08] px-2 py-[3px] leading-none font-medium text-warn">TESTNET</span>}
        <TorIndicator />
      </div>
    </footer>
  );
}

export function Dot({ color, live }: { color: string; live?: boolean }) {
  return (
    <span className="relative flex size-2">
      {live && <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: color }} />}
      <span className="relative size-2 rounded-full" style={{ background: color }} />
    </span>
  );
}

interface NetStat {
  btcHeight: number | null;
  evmMs: number | null;
  solMs: number | null;
  errors: number;
}

/** Tip height / RPC round-trip of the first BTC, EVM and Solana backends, re-probed every 30 s. */
export function useNetProbe(): NetStat {
  const { adapters } = useApp();
  const tor = useTor();
  // Re-probe as soon as Tor comes up instead of waiting for the next 30 s tick.
  const torReady = tor.status?.state === 'ready';
  const cbfSyncedAt = useCbf().status?.lastSyncUnix ?? null;
  const [stat, setStat] = useState<NetStat>({ btcHeight: null, evmMs: null, solMs: null, errors: 0 });
  useEffect(() => {
    if (!adapters) return;
    let alive = true;
    const probe = async () => {
      const evm = [...adapters.evm.values()][0];
      const [btc, e, s] = await Promise.allSettled([
        adapters.btc ? adapters.btc.tipHeight() : Promise.resolve(null),
        (async () => {
          if (!evm) return null;
          const t0 = performance.now();
          await evm.blockNumber();
          return Math.round(performance.now() - t0);
        })(),
        (async () => {
          if (!adapters.sol) return null;
          const t0 = performance.now();
          await adapters.sol.slot();
          return Math.round(performance.now() - t0);
        })(),
      ]);
      if (!alive) return;
      setStat({
        btcHeight: btc.status === 'fulfilled' ? btc.value : null,
        evmMs: e.status === 'fulfilled' ? e.value : null,
        solMs: s.status === 'fulfilled' ? s.value : null,
        errors: [btc, e, s].filter((x) => x.status === 'rejected').length,
      });
    };
    void probe();
    const id = window.setInterval(probe, 30_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [adapters, torReady, cbfSyncedAt]);

  return stat;
}

/** Live status bar of the unlocked app. */
export function StatusBar({ syncing, failedChains, serverDownChains = [], extra }: { syncing: boolean; failedChains: string[]; serverDownChains?: string[]; extra?: ReactNode }) {
  const { adapters, settings, network } = useApp();
  const { t } = useT();
  const tor = useTor();
  const torBlocked = torWaiting(tor);
  const stat = useNetProbe();
  const cbfMode = bitcoinServerFor(settings.servers, network).kind === 'cbf';
  const cbf = useCbf().status;
  const degraded = failedChains.length > 0 || stat.errors > 0;

  return (
    <StatusFrame
      left={
        <>
          <span className="flex items-center gap-2 text-text2">
            <Dot color={torBlocked ? '#8C929D' : syncing ? '#7CC4FF' : degraded ? '#F5B74F' : '#3DDC97'} live={syncing && !torBlocked} />
            {torBlocked
              ? t('shell.waitingTor')
              : cbfMode && cbf && cbf.state !== 'synced' && cbf.state !== 'error' && cbf.state !== 'idle'
                ? t('shell.syncingFilters')
                : syncing
                ? t('shell.syncing')
                : serverDownChains.length > 0
                  ? t('shell.serverDownChains', { chains: serverDownChains.map((k) => adapters?.all.find((x) => x.chain.key === k)?.chain.label ?? k).join(', ') })
                  : degraded
                    ? failedChains.length
                      ? t('shell.partialUnreachable', { chains: failedChains.join(', ') })
                      : t('shell.partial')
                    : t('shell.synced')}
          </span>
          {extra}
        </>
      }
    />
  );
}
