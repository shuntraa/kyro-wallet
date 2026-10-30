// SPDX-License-Identifier: GPL-3.0-or-later
// Status bar (28 px, Geist Mono): sync state, BTC block, RPC latencies,
// TESTNET / MODE DÉMO badges, version.

import { useEffect, useState, type ReactNode } from 'react';
import { fmtNumber } from '../lib/format';
import { useApp } from '../state/app';

export function StatusFrame({ left, right }: { left: ReactNode; right?: ReactNode }) {
  const { network, demo } = useApp();
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-rail bg-bg-deep px-3.5 font-mono text-[11px] text-faint">
      <div className="flex min-w-0 items-center gap-[18px] overflow-hidden whitespace-nowrap">{left}</div>
      <div className="flex shrink-0 items-center gap-[18px]">
        {right}
        {demo && <span className="font-semibold text-ice">MODE DÉMO</span>}
        {network === 'testnet' && <span className="text-warn">TESTNET</span>}
        <span>zéro télémétrie</span>
        <span>v{__APP_VERSION__} · GPLv3</span>
      </div>
    </footer>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="size-1.5 rounded-full" style={{ background: color }} />;
}

interface NetStat {
  btcHeight: number | null;
  evmMs: number | null;
  solMs: number | null;
  errors: number;
}

/** Live status bar of the unlocked app. */
export function StatusBar({ syncing, failedChains, extra }: { syncing: boolean; failedChains: string[]; extra?: ReactNode }) {
  const { adapters, accounts } = useApp();
  const [stat, setStat] = useState<NetStat>({ btcHeight: null, evmMs: null, solMs: null, errors: 0 });

  useEffect(() => {
    if (!adapters) return;
    let alive = true;
    const probe = async () => {
      const evm = [...adapters.evm.values()][0];
      const [btc, e, s] = await Promise.allSettled([
        adapters.btc.tipHeight(),
        (async () => {
          const t0 = performance.now();
          await evm?.blockNumber();
          return Math.round(performance.now() - t0);
        })(),
        (async () => {
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
  }, [adapters]);

  const evmLabel = adapters ? [...adapters.evm.values()][0]?.chain.label ?? 'EVM' : 'EVM';
  const solLabel = adapters?.sol.chain.label ?? 'Solana';
  const btcLabel = accounts?.network === 'testnet' ? 'BTC testnet' : 'BTC';
  const degraded = failedChains.length > 0 || stat.errors > 0;

  return (
    <StatusFrame
      left={
        <>
          <span className="flex items-center gap-1.5 text-mute">
            <Dot color={syncing ? '#7CC4FF' : degraded ? '#F5B74F' : '#3DDC97'} />
            {syncing ? 'Synchronisation…' : degraded ? `Partiel${failedChains.length ? ` · ${failedChains.join(', ')} injoignable` : ''}` : 'Synchronisé'}
          </span>
          <span>
            {btcLabel} · {stat.btcHeight !== null ? `bloc ${fmtNumber(stat.btcHeight, 0)}` : 'hors ligne'}
          </span>
          <span>
            {evmLabel} · {stat.evmMs !== null ? `${stat.evmMs} ms` : 'hors ligne'}
          </span>
          <span>
            {solLabel} · {stat.solMs !== null ? `${stat.solMs} ms` : 'hors ligne'}
          </span>
          {extra}
        </>
      }
    />
  );
}
