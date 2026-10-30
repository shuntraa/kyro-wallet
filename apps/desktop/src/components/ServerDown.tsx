// SPDX-License-Identifier: GPL-3.0-or-later
//
// Inline state when the user's own server does not answer (SERVER_UNREACHABLE) or the UI hit
// a replaced default (DEFAULT_SERVER_DISABLED). Kyro never retries against a public default:
// the only way out is the user's server, or the settings.

import { isCustomServerDown } from '@kyro/shared';
import { useApp } from '../state/app';
import { cn } from '../lib/cn';
import { IconWarn } from './icons';

/**
 * Compact filters before their first sync: Rust answers SERVER_UNREACHABLE « pas encore
 * synchronisé ». Not a server failure: the sync is running.
 */
export function cbfPending(error: unknown): boolean {
  const m = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return m.includes('filtres compacts') && m.includes('synchronis');
}

/** True when `error` (an error, or a message) means "your custom server is down". */
export function serverDown(error: unknown): boolean {
  return error !== undefined && error !== null && error !== '' && isCustomServerDown(error) && !cbfPending(error);
}

export function ServerDownLine({ className, what }: { className?: string; what?: string }) {
  const { navigate, phase } = useApp();
  return (
    <div role="alert" className={cn('flex items-center gap-2 text-[12px] text-warn', className)}>
      <IconWarn size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">Ton serveur ne répond pas{what ? ` (${what})` : ''}.</span>
        <span className="text-mute"> Kyro n’interroge jamais le serveur par défaut à sa place.</span>
      </span>
      {phase === 'ready' && (
        <button type="button" onClick={() => navigate({ name: 'settings', section: 'networks' })} className="shrink-0 font-semibold text-ice hover:underline">
          Ouvrir les réglages
        </button>
      )}
    </div>
  );
}
