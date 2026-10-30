// SPDX-License-Identifier: GPL-3.0-or-later
//
// Embedded Tor, visible side: status-bar indicator, failure dialog, "continue
// without Tor" confirmation, and the inline "waiting for Tor" state of data screens.
// State and rules: ../state/tor.ts (never a silent switch to clear).

import { isTorUnavailable } from '@kyro/shared';
import { useApp } from '../state/app';
import { torDetail, torIndicator, torStore, torWaiting, useTor } from '../state/tor';
import { cn } from '../lib/cn';
import { Dialog } from './ui/dialog';
import { Button, Notice, Spinner } from './ui/primitives';
import { IconGlobe, IconRefresh, IconShield, IconTor, IconWarn } from './icons';

const NNBSP = ' ';

/** Compact Tor state for the status bar (always visible, every phase). */
export function TorIndicator() {
  const tor = useTor();
  const { phase, navigate } = useApp();
  const kind = torIndicator(tor);
  const base = 'flex items-center gap-1.5 whitespace-nowrap';

  switch (kind) {
    case 'unknown':
      return (
        <span className={cn(base, 'text-mute')} title="État de Tor en cours de lecture">
          <IconTor size={12} className="text-faint" /> Tor · …
        </span>
      );
    case 'bootstrapping': {
      const p = Math.max(0, Math.min(99, Math.round(tor.status?.progress ?? 0)));
      return (
        <span role="status" aria-label={`Tor : connexion en cours, ${p} pour cent`} className={cn(base, 'text-mute')} title="Connexion au réseau Tor. Les requêtes attendent Tor, rien ne part en clair.">
          <IconTor size={12} className="animate-pulse text-faint" />
          <span className="tabular-nums">
            Tor · {p}
            {NNBSP}%
          </span>
        </span>
      );
    }
    case 'ready':
      return (
        <span role="status" className={cn(base, 'text-ice')} title="Toutes les connexions passent par Tor : les serveurs ne voient pas ton adresse IP.">
          <IconTor size={12} /> Tor actif
        </span>
      );
    case 'failed':
      return (
        <button
          type="button"
          onClick={() => torStore.openFailure()}
          className={cn(base, 'h-5 rounded-full bg-down/12 px-2 font-semibold text-down hover:bg-down/20')}
          title="Tor ne se connecte pas. Rien n’est envoyé en clair. Cliquer pour choisir quoi faire."
        >
          <IconWarn size={12} /> Tor indisponible
        </button>
      );
    case 'direct': {
      const label = (
        <>
          <IconGlobe size={12} /> Connexion directe (sans Tor)
        </>
      );
      const title = 'Tor est désactivé : les serveurs contactés voient ton adresse IP.';
      const cls = cn(base, 'h-5 rounded-full bg-warn/14 px-2 font-semibold text-warn');
      return phase === 'ready' ? (
        <button type="button" onClick={() => navigate({ name: 'settings', section: 'privacy' })} className={cn(cls, 'hover:bg-warn/20')} title={`${title} Cliquer pour ouvrir les réglages de confidentialité.`}>
          {label}
        </button>
      ) : (
        <span className={cls} title={title}>
          {label}
        </span>
      );
    }
  }
}

/** True when a data error should read "waiting for Tor" rather than a generic failure. */
export function useTorBlocked(error?: unknown): boolean {
  const tor = useTor();
  if (tor.enabled === false) return false;
  return torWaiting(tor) || (error !== undefined && error !== null && isTorUnavailable(error));
}

/** Inline state of a data screen blocked by Tor (instead of a generic error). */
export function TorWait({ className }: { className?: string }) {
  const tor = useTor();
  const failed = torIndicator(tor) === 'failed';
  return (
    <div role="status" className={cn('flex items-center gap-2 text-[12px] text-mute', className)}>
      {failed ? <IconTor size={14} className="shrink-0 text-faint" /> : <Spinner className="size-3 shrink-0 border-[1.5px] text-faint" />}
      <span className="min-w-0 flex-1">
        En attente de Tor…
        <span className="text-faint"> {failed ? 'Tor ne se connecte pas, rien n’est envoyé en clair.' : 'Les données arrivent dès que Tor est connecté.'}</span>
      </span>
      {failed && (
        <button type="button" onClick={() => torStore.openFailure()} className="shrink-0 font-semibold text-ice hover:underline">
          Que faire ?
        </button>
      )}
    </div>
  );
}

/** What servers see without Tor: shared by the failure flow and the settings switch. */
export function DirectConnectionWarning() {
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
      <p className="m-0">
        Sans Tor, chaque serveur contacté par Kyro verra <strong className="font-semibold text-text">ton adresse IP</strong> et pourra la relier aux adresses et aux transactions que tu consultes :
      </p>
      <ul className="m-0 mt-1.5 flex list-disc flex-col gap-0.5 pl-5">
        <li>les nœuds Bitcoin, Ethereum et Solana (soldes, historique, envois) ;</li>
        <li>CoinGecko (prix) et les agrégateurs de swap (devis) ;</li>
        <li>ton fournisseur d’accès, qui verra quels serveurs tu contactes.</li>
      </ul>
    </Notice>
  );
}

/** Failure dialog + explicit confirmation. Mounted once, at the root of the app. */
export function TorDialogs() {
  const tor = useTor();
  const { settings, saveSettings } = useApp();
  const detail = torDetail(tor.episode?.reason ?? tor.status?.message);

  return (
    <>
      <Dialog open={tor.dialog === 'failure'} onOpenChange={(v) => (v ? undefined : torStore.cancel())} title="Tor ne se connecte pas" className="w-[560px]">
        <p className="m-0 text-[14px] leading-[1.55] text-text2">Kyro fait passer toutes ses connexions par Tor pour cacher ton adresse IP. Tor n’arrive pas à se connecter pour l’instant.</p>
        <Notice icon={<IconShield size={16} className="mt-0.5 shrink-0 text-ice" />}>
          <strong className="font-semibold text-text">Kyro refuse d’envoyer quoi que ce soit en clair.</strong> Aucune requête n’est partie sans Tor : soldes, prix et historique restent en attente tant que tu n’as pas choisi.
        </Notice>
        {detail && <p className="m-0 font-mono text-[11px] leading-[1.5] break-words text-faint">Détail : {detail}</p>}
        {tor.actionError && <Notice tone="error">{tor.actionError}</Notice>}
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" onClick={() => torStore.requestDisable('failure')} disabled={tor.busy}>
            Continuer sans Tor
          </Button>
          <div className="flex gap-2">
            <Button onClick={() => torStore.cancel()} disabled={tor.busy}>
              Annuler
            </Button>
            <Button variant="primary" onClick={() => void torStore.retry()} disabled={tor.busy}>
              {tor.busy ? <Spinner /> : <IconRefresh size={15} />} Réessayer
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={tor.dialog === 'confirm-direct'}
        onOpenChange={(v) => (v ? undefined : torStore.cancelDisable())}
        title="Se connecter sans Tor ?"
        description="Kyro ne le fera jamais tout seul : confirme que tu acceptes une connexion directe."
        className="w-[560px]"
      >
        <DirectConnectionWarning />
        <p className="m-0 text-[13px] leading-[1.55] text-mute">Tor restera désactivé jusqu’à ce que tu le réactives dans Réglages › Confidentialité.</p>
        {tor.actionError && <Notice tone="error">{tor.actionError}</Notice>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="primary" onClick={() => torStore.cancelDisable()} disabled={tor.busy}>
            Garder Tor
          </Button>
          <Button variant="dangerOutline" disabled={tor.busy} onClick={() => void torStore.confirmDisable(() => saveSettings({ ...settings, tor: { enabled: false } }))}>
            {tor.busy && <Spinner />} Oui, continuer sans Tor
          </Button>
        </div>
      </Dialog>
    </>
  );
}
