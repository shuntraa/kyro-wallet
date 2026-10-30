// SPDX-License-Identifier: GPL-3.0-or-later
// Navigation rail (84 px).

import type { ReactNode } from 'react';
import { motion } from 'motion/react';
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
      className={cn('group press relative flex h-[58px] w-[72px] flex-col items-center justify-center gap-[6px] rounded-ctl', active ? 'text-text' : 'text-faint hover:text-text2')}
    >
      {/* The active mark slides from item to item (shared layout). */}
      {active && (
        <motion.span layoutId="rail-active" aria-hidden="true" className="absolute inset-0 rounded-ctl border border-line-2 bg-raised" transition={{ type: 'spring', stiffness: 480, damping: 38, mass: 0.8 }}>
          <span className="absolute top-1/2 -left-[7px] h-5 w-[2px] -translate-y-1/2 rounded-full bg-ice" />
        </motion.span>
      )}
      <span className={cn('relative z-10 transition-transform duration-200 ease-[cubic-bezier(.22,1,.36,1)] group-hover:-translate-y-px', active && 'text-ice')}>{icon}</span>
      <span className={cn('relative z-10 text-[10px] tracking-[0.01em]', active ? 'font-medium' : 'font-normal')}>{label}</span>
    </button>
  );
}

export function NavRail() {
  const { route, navigate, lock, hwOnly } = useApp();
  const k = railKeyOf(route);
  return (
    <nav aria-label="Navigation" className="flex w-[84px] shrink-0 flex-col items-center gap-0.5 border-r border-rail bg-bg-deep py-3">
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
        className="press group mt-2 flex size-11 items-center justify-center rounded-ctl border border-line-2 text-mute hover:border-line-3 hover:bg-raised hover:text-text"
      >
        <IconLock size={18} />
      </button>
      )}
    </nav>
  );
}
