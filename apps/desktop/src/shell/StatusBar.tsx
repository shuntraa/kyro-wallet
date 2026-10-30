// SPDX-License-Identifier: GPL-3.0-or-later
// Status bar (28 px, Geist Mono): sync state, BTC block, RPC latencies,
// Tor state (always visible), TESTNET / MODE DÉMO badges, version.

import { useEffect, useState, type ReactNode } from 'react';
import { fmtNumber } from '../lib/format';
import { bitcoinServerFor } from '@kyro/shared';
import { useApp } from '../state/app';
import { cbfPhaseLabel, useCbf } from '../state/cbf';
import { torWaiting, useTor } from '../state/tor';
import { TorIndicator } from '../components/Tor';

export function StatusFrame({ left, right }: { left: ReactNode; right?: ReactNode }) {
  const { network, demo } = useApp();
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-rail bg-bg-deep px-3.5 font-mono text-[11px] text-faint">
      <div className="flex min-w-0 items-center gap-[18px] overflow-hidden whitespace-nowrap">{left}</div>
      <div className="flex shrink-0 items-center gap-[18px]">
        <TorIndicator />
        {right}
        {demo && <span className="rounded-[3px] border border-ice/30 px-1.5 py-px leading-none font-medium tracking-[0.06em] text-ice">MODE DÉMO</span>}
        {network === 'testnet' && <span className="rounded-[3px] border border-warn/40 bg-warn/[.08] px-1.5 py-px leading-none font-medium tracking-[0.06em] text-warn">TESTNET</span>}
        <span>zéro télémétrie</span>
        <span>v{__APP_VERSION__} · GPLv3</span>
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
export function StatusBar({ syncing, failedChains, serverDownChains = [], extra }: { syncing: boolean; failedChains: string[]; serverDownChains?: string[]; extra?: ReactNode }) {
  const { adapters, accounts, settings, network } = useApp();
  // Small "perso" hint next to a chain served by the user's own server.
  const custom = {
    btc: bitcoinServerFor(settings.servers, network).kind !== 'default',
    evm: adapters ? settings.servers.evm[String([...adapters.evm.values()][0]?.chain.chainId)] !== undefined : false,
    sol: adapters?.sol ? settings.servers.solana[adapters.sol.chain.cluster] !== undefined : false,
  };
  const perso = (on: boolean) => (on ? <span className="text-mute" title="Serveur personnalisé (Réglages › Réseaux et serveurs)"> · perso</span> : null);
  const tor = useTor();
  const torBlocked = torWaiting(tor);
  // Re-probe as soon as Tor comes up instead of waiting for the next 30 s tick.
  const torReady = tor.status?.state === 'ready';
  // …and as soon as a compact-filter sync completes.
  const cbfSyncedAt = useCbf().status?.lastSyncUnix ?? null;
  const [stat, setStat] = useState<NetStat>({ btcHeight: null, evmMs: null, solMs: null, errors: 0 });

  useEffect(() => {
    if (!adapters) return;
    let alive = true;
    const probe = async () => {
      const evm = [...adapters.evm.values()][0];
      const [btc, e, s] = await Promise.allSettled([
        // A hardware-wallet account may lack a chain: nothing to probe, not an error.
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
  // Compact filters: the sync phase replaces the block height (driven by `cbf-status`).
  const cbfMode = bitcoinServerFor(settings.servers, network).kind === 'cbf';
  const cbf = useCbf().status;
  const cbfText = !cbf
    ? 'filtres compacts'
    : cbf.state === 'filters'
      ? `filtres ${Math.round(cbf.progress * 100)}\u202f%`
      : cbf.state === 'headers'
        ? `en-têtes${cbf.tipHeight != null ? ` ${fmtNumber(cbf.tipHeight, 0)}` : ''}`
        : cbf.state === 'synced'
          ? `${cbf.peers.length} pair${cbf.peers.length > 1 ? 's' : ''}${stat.btcHeight !== null ? ` · bloc ${fmtNumber(stat.btcHeight, 0)}` : ''}`
          : cbfPhaseLabel(cbf);
  const degraded = failedChains.length > 0 || stat.errors > 0;

  return (
    <StatusFrame
      left={
        <>
          <span className="flex items-center gap-1.5 text-mute">
            <Dot color={torBlocked ? '#8C929D' : syncing ? '#7CC4FF' : degraded ? '#F5B74F' : '#3DDC97'} live={syncing && !torBlocked} />
            {torBlocked
              ? 'En attente de Tor…'
              : cbfMode && cbf && cbf.state !== 'synced' && cbf.state !== 'error' && cbf.state !== 'idle'
                ? 'Synchronisation des filtres…'
                : syncing
                ? 'Synchronisation…'
                : serverDownChains.length > 0
                  ? `Ton serveur ne répond pas · ${serverDownChains.map((k) => adapters?.all.find((x) => x.chain.key === k)?.chain.label ?? k).join(', ')}`
                  : degraded
                    ? `Partiel${failedChains.length ? ` · ${failedChains.join(', ')} injoignable` : ''}`
                    : 'Synchronisé'}
          </span>
          {adapters?.btc !== null && (
          <span>
            {btcLabel}
            {cbfMode ? (
              <span title="Bitcoin par filtres compacts (BIP157/158) : aucun serveur ne voit tes adresses"> · CBF · {cbfText}</span>
            ) : (
              <>
                {perso(custom.btc)} · {stat.btcHeight !== null ? `bloc ${fmtNumber(stat.btcHeight, 0)}` : 'hors ligne'}
              </>
            )}
          </span>
          )}
          {/* A hardware-wallet account only shows the chains read from the device. */}
          {(!adapters || adapters.evm.size > 0) && (
            <span>
              {evmLabel}
              {perso(custom.evm)} · {stat.evmMs !== null ? `${stat.evmMs} ms` : 'hors ligne'}
            </span>
          )}
          {adapters?.sol !== null && (
            <span>
              {solLabel}
              {perso(custom.sol)} · {stat.solMs !== null ? `${stat.solMs} ms` : 'hors ligne'}
            </span>
          )}
          {extra}
        </>
      }
    />
  );
}
