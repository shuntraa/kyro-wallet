// SPDX-License-Identifier: GPL-3.0-or-later
//
// Inline state when the user's own server does not answer (SERVER_UNREACHABLE) or the UI hit
// a replaced default (DEFAULT_SERVER_DISABLED). Kyro never retries against a public default:
// the only way out is the user's server, or the settings.

import { isCustomServerDown } from '@kyro/shared';
import { useApp } from '../state/app';
import { cn } from '../lib/cn';
import { IconWarn } from './icons';
import { useT } from '../i18n';

/**
 * Compact filters before their first sync: Rust answers SERVER_UNREACHABLE « pas encore
 * synchronisé ». Not a server failure: the sync is running.
 */
export function cbfPending(error: unknown): boolean {
  const m = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return (m.includes('filtres compacts') && m.includes('synchronis')) || (/compact filters/i.test(m) && /\bsync/i.test(m));
}

/**
 * Dogecoin / Dash testnets have no free public server: until the user sets one, Rust answers SERVER_INVALID
 * « aucun serveur public gratuit… configure ton serveur ». Not a failure: a missing setting.
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
 * TRON with a plain java-tron node: everything works but the history, which needs TronGrid's
 * `/v1` API (Rust: SERVER_UNREACHABLE « …l'historique exige l'API /v1 de TronGrid »). Not a
 * server failure: a limitation of that kind of server.
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

/** True when `error` (an error, or a message) means "your custom server is down". */
export function serverDown(error: unknown): boolean {
  return error !== undefined && error !== null && error !== '' && isCustomServerDown(error) && !cbfPending(error) && !tronNoHistory(error);
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
