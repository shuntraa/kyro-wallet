// SPDX-License-Identifier: GPL-3.0-or-later
// Inline state when a server does not answer. Rust answers SERVER_UNREACHABLE for any server, custom
// or default: "your server is not responding" only when the user configured one for that chain,
// otherwise a neutral "network unreachable, retrying…" (the default server just failed this time).

import { useCallback } from 'react';
import { findChain } from '@kyro/chains';
import { anyCustomServer, hasCustomServer, isCustomServerDown } from '@kyro/shared';
import { useApp } from '../state/app';
import { cn } from '../lib/cn';
import { IconWarn } from './icons';
import { useT } from '../i18n';

/**
 * Compact filters before their first sync: Rust answers SERVER_UNREACHABLE « pas encore synchronisé
 * ».
 */
export function cbfPending(error: unknown): boolean {
  const m = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return (m.includes('filtres compacts') && m.includes('synchronis')) || (/compact filters/i.test(m) && /\bsync/i.test(m));
}

/**
 * Dogecoin / Dash testnets have no free public server: until the user sets one, Rust answers
 * SERVER_INVALID « aucun serveur public gratuit… configure ton serveur ».
 */
export function serverMissing(error: unknown): boolean {
  const m = typeof error === 'string' ? error : error instanceof Error ? error.message : typeof error === 'object' && error !== null ? String((error as { message?: unknown }).message ?? '') : '';
  return /aucun serveur public|configure ton serveur|no free public server|set up your (?:own )?server|configure your server/i.test(m);
}

/** Honest state of a chain without any server (Dogecoin by default). */
export function ServerMissingLine({ className, coin = 'Dogecoin' }: { className?: string; coin?: string }) {
  const { navigate, phase } = useApp();
  const { t } = useT();
  return (
    <div role="status" className={cn('flex items-center gap-2 text-[12px] text-warn', className)}>
      <IconWarn size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{t('shell.noPublicServer')}</span>
        <span className="text-mute"> {t('shell.noPublicServerDetail', { coin })}</span>
      </span>
      {phase === 'ready' && (
        <button type="button" onClick={() => navigate({ name: 'settings', section: 'networks' })} className="shrink-0 font-semibold text-ice hover:underline">
          {t('shell.configure')}
        </button>
      )}
    </div>
  );
}

/**
 * TRON with a plain java-tron node: everything works but the history, which needs TronGrid's `/v1`
 * API (Rust: SERVER_UNREACHABLE « …l'historique exige l'API /v1 de TronGrid »).
 */
export function tronNoHistory(error: unknown): boolean {
  const m = typeof error === 'string' ? error : error instanceof Error ? error.message : typeof error === 'object' && error !== null ? String((error as { message?: unknown }).message ?? '') : '';
  return /exige l.API \/v1 de TronGrid|requires TronGrid.s \/v1 API/i.test(m);
}

export function TronNoHistoryLine({ className }: { className?: string }) {
  const { navigate, phase } = useApp();
  const { t } = useT();
  return (
    <div role="status" className={cn('flex items-center gap-2 text-[12px] text-mute', className)}>
      <IconWarn size={14} className="shrink-0 text-warn" />
      <span className="min-w-0 flex-1">
        <span className="font-semibold text-text2">{t('shell.tronNoHistory')}</span> {t('shell.tronNoHistoryDetail')}
      </span>
      {phase === 'ready' && (
        <button type="button" onClick={() => navigate({ name: 'settings', section: 'networks' })} className="shrink-0 font-semibold text-ice hover:underline">
          {t('common.settings')}
        </button>
      )}
    </div>
  );
}

/** A server (custom or default) did not answer: SERVER_UNREACHABLE / DEFAULT_SERVER_DISABLED, minus the special cases above. */
function unreachable(error: unknown): boolean {
  return error !== undefined && error !== null && error !== '' && isCustomServerDown(error) && !cbfPending(error) && !tronNoHistory(error);
}

/** True when `error` means "your custom server is down": only when `custom` (the chain has a custom server). */
export function serverDown(error: unknown, custom: boolean): boolean {
  return custom && unreachable(error);
}

/** True when a default server did not answer (`custom` false): a neutral, retried "network unreachable". */
export function networkDown(error: unknown, custom: boolean): boolean {
  return !custom && unreachable(error);
}

/**
 * `(chainKey?) => boolean`: whether that chain of the current network uses a custom server. Without
 * a chain key (an error whose chain is unknown), whether any chain does.
 */
export function useCustomServer(): (chainKey?: string) => boolean {
  const { settings, network } = useApp();
  return useCallback(
    (chainKey?: string) => {
      if (chainKey === undefined) return anyCustomServer(settings.servers, network);
      const chain = findChain(network, chainKey);
      return chain ? hasCustomServer(settings.servers, chain) : false;
    },
    [settings.servers, network],
  );
}

/** A default server did not answer: honest and neutral, the next refresh retries on its own. */
export function NetworkDownLine({ className, what }: { className?: string; what?: string }) {
  const { t } = useT();
  return (
    <div role="status" className={cn('flex items-center gap-2 text-[12px] text-mute', className)}>
      <span aria-hidden="true" className="inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
      <span className="min-w-0 flex-1">{what ? t('shell.networkDownWhat', { what }) : t('shell.networkDown')}</span>
    </div>
  );
}

export function ServerDownLine({ className, what }: { className?: string; what?: string }) {
  const { navigate, phase } = useApp();
  const { t } = useT();
  return (
    <div role="alert" className={cn('flex items-center gap-2 text-[12px] text-warn', className)}>
      <IconWarn size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{what ? t('shell.serverNotRespondingWhat', { what }) : t('shell.serverNotResponding')}</span>
        <span className="text-mute"> {t('shell.serverNoFallback')}</span>
      </span>
      {phase === 'ready' && (
        <button type="button" onClick={() => navigate({ name: 'settings', section: 'networks' })} className="shrink-0 font-semibold text-ice hover:underline">
          {t('shell.openSettings')}
        </button>
      )}
    </div>
  );
}
