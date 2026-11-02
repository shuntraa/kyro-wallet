// SPDX-License-Identifier: GPL-3.0-or-later
// Status bar (28 px, Geist Mono): sync state, BTC block, RPC latencies, Tor state (always visible),
// TESTNET / MODE DÉMO badges, version.

import { useEffect, useState, type ReactNode } from 'react';
import { fmtNumber } from '../lib/format';
import { bitcoinServerFor } from '@kyro/shared';
import { useApp } from '../state/app';
import { cbfPhaseLabel, useCbf } from '../state/cbf';
import { torWaiting, useTor } from '../state/tor';
import { TorIndicator } from '../components/Tor';
import { useT } from '../i18n';

export function StatusFrame({ left, right }: { left: ReactNode; right?: ReactNode }) {
  const { network, demo } = useApp();
  const { t } = useT();
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between gap-2 border-t border-rail bg-bg-deep px-3.5 font-mono text-[11px] text-faint">
      <div className="flex min-w-0 items-center gap-[18px] overflow-hidden pr-6 whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]">{left}</div>
      <div className="flex shrink-0 items-center gap-[18px]">
        <TorIndicator />
        {right}
        {demo && <span className="rounded-[3px] border border-ice/30 px-1.5 py-px leading-none font-medium tracking-[0.06em] text-ice">{t('shell.demoMode')}</span>}
        {network === 'testnet' && <span className="rounded-[3px] border border-warn/40 bg-warn/[.08] px-1.5 py-px leading-none font-medium tracking-[0.06em] text-warn">TESTNET</span>}
        <span>v{__APP_VERSION__}</span>
      </div>
    </footer>
  );
}

export function Dot({ color, live }: { color: string; live?: boolean }) {
  return (
    <span className="relative flex size-1.5">
      {live && <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: color }} />}
      <span className="relative size-1.5 rounded-full" style={{ background: color }} />
    </span>
  );
}

interface NetStat {
  btcHeight: number | null;
  evmMs: number | null;
  solMs: number | null;
  errors: number;
}

/** Live status bar of the unlocked app. */
export function StatusBar({ syncing, failedChains, serverDownChains = [], networkDownChains = [], extra }: { syncing: boolean; failedChains: string[]; serverDownChains?: string[]; networkDownChains?: string[]; extra?: ReactNode }) {
  const { adapters, accounts, settings, network } = useApp();
  const { t, tp } = useT();
  const custom = {
    btc: bitcoinServerFor(settings.servers, network).kind !== 'default',
    evm: adapters ? settings.servers.evm[String([...adapters.evm.values()][0]?.chain.chainId)] !== undefined : false,
    sol: adapters?.sol ? settings.servers.solana[adapters.sol.chain.cluster] !== undefined : false,
  };
  const perso = (on: boolean) => (on ? <span className="text-mute" title={t('shell.customServerTitle')}> · {t('shell.customShort')}</span> : null);
  const tor = useTor();
  const torBlocked = torWaiting(tor);
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

  const evmLabel = adapters ? [...adapters.evm.values()][0]?.chain.label ?? 'EVM' : 'EVM';
  const solLabel = adapters?.sol?.chain.label ?? 'Solana';
  const btcLabel = accounts?.network === 'testnet' ? 'BTC testnet' : 'BTC';
  const cbfMode = bitcoinServerFor(settings.servers, network).kind === 'cbf';
  const cbf = useCbf().status;
  const cbfText = !cbf
    ? t('shell.cbfCompact')
    : cbf.state === 'filters'
      ? t('shell.cbfFiltersPct', { n: Math.round(cbf.progress * 100) })
      : cbf.state === 'headers'
        ? cbf.tipHeight != null
          ? t('shell.cbfHeadersAt', { height: fmtNumber(cbf.tipHeight, 0) })
          : t('shell.cbfHeaders')
        : cbf.state === 'synced'
          ? `${tp('shell.peers', cbf.peers.length)}${stat.btcHeight !== null ? ` · ${t('shell.block', { height: fmtNumber(stat.btcHeight, 0) })}` : ''}`
          : cbfPhaseLabel(cbf);
  const degraded = failedChains.length > 0 || stat.errors > 0;

  return (
    <StatusFrame
      left={
        <>
          <span className="flex items-center gap-1.5 text-mute">
            <Dot color={torBlocked ? '#8C929D' : syncing ? '#7CC4FF' : degraded ? '#F5B74F' : '#3DDC97'} live={syncing && !torBlocked} />
            {torBlocked
              ? t('shell.waitingTor')
              : cbfMode && cbf && cbf.state !== 'synced' && cbf.state !== 'error' && cbf.state !== 'idle'
                ? t('shell.syncingFilters')
                : syncing
                ? t('shell.syncing')
                : serverDownChains.length > 0
                  ? t('shell.serverDownChains', { chains: serverDownChains.map((k) => adapters?.all.find((x) => x.chain.key === k)?.chain.label ?? k).join(', ') })
                  : networkDownChains.length > 0
                  ? t('shell.networkDownChains', { chains: networkDownChains.map((k) => adapters?.all.find((x) => x.chain.key === k)?.chain.label ?? k).join(', ') })
                  : degraded
                    ? failedChains.length
                      ? t('shell.partialUnreachable', { chains: failedChains.join(', ') })
                      : t('shell.partial')
                    : t('shell.synced')}
          </span>
          {adapters?.btc !== null && (
          <span>
            {btcLabel}
            {cbfMode ? (
              <span title={t('shell.cbfTitle')}> · CBF · {cbfText}</span>
            ) : (
              <>
                {perso(custom.btc)} · {stat.btcHeight !== null ? t('shell.block', { height: fmtNumber(stat.btcHeight, 0) }) : t('shell.offline')}
              </>
            )}
          </span>
          )}
          {(!adapters || adapters.evm.size > 0) && (
            <span>
              {evmLabel}
              {perso(custom.evm)} · {stat.evmMs !== null ? `${stat.evmMs} ms` : t('shell.offline')}
            </span>
          )}
          {adapters?.sol !== null && (
            <span>
              {solLabel}
              {perso(custom.sol)} · {stat.solMs !== null ? `${stat.solMs} ms` : t('shell.offline')}
            </span>
          )}
          {extra}
        </>
      }
    />
  );
}
