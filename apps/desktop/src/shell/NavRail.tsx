// SPDX-License-Identifier: GPL-3.0-or-later
// Navigation rail (84 px).

import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { useApp, type Route } from '../state/app';
import { IconClock, IconLayers, IconLock, IconSliders, IconStake, IconSwap, IconWallet } from '../components/icons';

type RailKey = 'portfolio' | 'assets' | 'swap' | 'staking' | 'history' | 'settings';

export function railKeyOf(r: Route): RailKey {
  switch (r.name) {
    case 'asset':
    case 'assets':
      return 'assets';
    case 'send':
    case 'receive':
    case 'portfolio':
      return 'portfolio';
    default:
      return r.name;
  }
}

function RailItem({ active, label, icon, onClick }: { active: boolean; label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn('relative flex h-[60px] w-[68px] flex-col items-center justify-center gap-[5px] rounded-[14px]', active ? 'bg-raised text-text' : 'text-mute hover:bg-raised/60 hover:text-text2')}
    >
      {active && <span aria-hidden="true" className="absolute top-[18px] -left-2 h-6 w-[3px] rounded-r-[3px] bg-ice" />}
      <span className={active ? 'text-ice' : ''}>{icon}</span>
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}

export function NavRail() {
  const { route, navigate, lock, hwOnly } = useApp();
  const k = railKeyOf(route);
  return (
    <nav aria-label="Navigation" className="flex w-[84px] shrink-0 flex-col items-center gap-1 border-r border-rail py-3.5">
      <RailItem active={k === 'portfolio'} label="Portefeuille" icon={<IconWallet size={20} />} onClick={() => navigate({ name: 'portfolio' })} />
      <RailItem active={k === 'assets'} label="Actifs" icon={<IconLayers size={20} />} onClick={() => navigate({ name: 'assets' })} />
      <RailItem active={k === 'swap'} label="Swap" icon={<IconSwap size={20} />} onClick={() => navigate({ name: 'swap' })} />
      <RailItem active={k === 'staking'} label="Staking" icon={<IconStake size={20} />} onClick={() => navigate({ name: 'staking' })} />
      <RailItem active={k === 'history'} label="Historique" icon={<IconClock size={20} />} onClick={() => navigate({ name: 'history' })} />
      <div className="flex-1" />
      <RailItem active={k === 'settings'} label="Réglages" icon={<IconSliders size={20} />} onClick={() => navigate({ name: 'settings' })} />
      {!hwOnly && (
      <button
        type="button"
        aria-label="Verrouiller le coffre"
        title="Verrouiller le coffre"
        onClick={() => void lock()}
        className="mt-1.5 flex size-12 items-center justify-center rounded-full border border-line-2 bg-card text-text hover:bg-raised"
      >
        <IconLock size={18} />
      </button>
      )}
    </nav>
  );
}
