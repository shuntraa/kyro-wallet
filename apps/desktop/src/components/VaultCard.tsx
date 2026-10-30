// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useState } from 'react';
import { fmtCountdown } from '../lib/format';
import { getApprovals, getBackupState } from '../lib/storage';
import { hwFingerprint } from '@kyro/chains';
import { useApp } from '../state/app';
import { IconShield, IconUsbKey } from './icons';
import { Badge } from './ui/primitives';
import { DeviceBadge } from './hw';

export function VaultCard() {
  const { status, network, navigate, activeHw, hwAccounts } = useApp();
  const [left, setLeft] = useState<number | null>(status?.lockInSecs ?? null);

  // Local 1 s countdown between the 5 s vault_status polls.
  useEffect(() => {
    setLeft(status?.lockInSecs ?? null);
    if (status?.lockInSecs === null || status?.lockInSecs === undefined) return;
    const t0 = Date.now();
    const base = status.lockInSecs;
    const id = window.setInterval(() => setLeft(Math.max(0, base - Math.floor((Date.now() - t0) / 1000))), 1000);
    return () => window.clearInterval(id);
  }, [status]);

  const unlimited = useMemo(() => getApprovals(network).filter((a) => a.unlimited).length, [network]);
  const backup = getBackupState();
  const pct = status && left !== null && status.autoLockSecs > 0 ? Math.min(100, (left / status.autoLockSecs) * 100) : 0;

  if (activeHw) {
    // Hardware-wallet account: no key in Kyro, nothing to lock here.
    return (
      <section aria-label="Hardware wallet" className="flex flex-1 flex-col gap-3.5 rounded-panel border border-line bg-card px-5 py-[18px]">
        <div className="flex items-center gap-3">
          <span className="flex size-[38px] items-center justify-center rounded-ctl bg-ice/12 text-ice">
            <IconUsbKey size={18} />
          </span>
          <span className="flex flex-1 flex-col">
            <span className="text-[15px] font-semibold">{activeHw.label}</span>
            <span className="text-[12px] text-mute">Clés dans l’appareil, jamais dans Kyro</span>
          </span>
          <DeviceBadge device={activeHw.device} model={activeHw.model} />
        </div>
        <div className="flex flex-col text-[13px]">
          <Row label="Empreinte">
            <span className="font-mono text-[12px]">{hwFingerprint(activeHw) ?? '—'}</span>
          </Row>
          <Row label="Compte">
            <span className="font-semibold">n° {activeHw.account}</span>
          </Row>
          <Row label="Autorisations illimitées">
            <button type="button" onClick={() => navigate({ name: 'history' })} className={unlimited ? 'font-semibold text-down hover:underline' : 'font-semibold text-up'}>
              {unlimited ? `${unlimited} active${unlimited > 1 ? 's' : ''}` : 'Aucune'}
            </button>
          </Row>
          <Row label="Appareils">
            <button type="button" onClick={() => navigate({ name: 'settings', section: 'hardware' })} className="font-semibold text-ice hover:underline">
              Gérer
            </button>
          </Row>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Coffre" className="flex flex-1 flex-col gap-3.5 rounded-panel border border-line bg-card px-5 py-[18px]">
      <div className="flex items-center gap-3">
        <span className="flex size-[38px] items-center justify-center rounded-ctl bg-ice/12 text-ice">
          <IconShield size={18} sw={2} />
        </span>
        <span className="flex flex-1 flex-col">
          <span className="text-[15px] font-semibold">Coffre</span>
          <span className="text-[12px] text-mute">Clés chiffrées sur cet appareil</span>
        </span>
        <Badge tone={status?.unlocked ? 'up' : 'mute'} className="h-6 text-[12px]">
          {status?.unlocked ? 'Ouvert' : 'Fermé'}
        </Badge>
      </div>
      <div className="flex flex-col gap-[7px]">
        <div className="flex justify-between text-[12px]">
          <span className="text-mute">Verrouillage auto</span>
          <span className="font-mono">{left !== null ? fmtCountdown(left) : '—'}</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-control-2">
          <div className="h-1 rounded-full bg-ice transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="flex flex-col text-[13px]">
        <Row label="Hardware wallet">
          <button type="button" onClick={() => navigate({ name: 'settings', section: 'hardware' })} className="font-semibold text-ice hover:underline">
            {hwAccounts.length ? `${hwAccounts.length} compte${hwAccounts.length > 1 ? 's' : ''}` : 'Ajouter'}
          </button>
        </Row>
        <Row label="Autorisations illimitées">
          <button type="button" onClick={() => navigate({ name: 'history' })} className={unlimited ? 'font-semibold text-down hover:underline' : 'font-semibold text-up'}>
            {unlimited ? `${unlimited} active${unlimited > 1 ? 's' : ''}` : 'Aucune'}
          </button>
        </Row>
        <Row label="Phrase de récupération">
          {backup === 'confirmed' ? (
            <span className="font-semibold text-up">Sauvegardée</span>
          ) : backup === 'imported' ? (
            <span className="font-semibold text-up">Importée</span>
          ) : (
            <button type="button" onClick={() => navigate({ name: 'settings', section: 'security' })} className="font-semibold text-warn hover:underline">
              Non vérifiée
            </button>
          )}
        </Row>
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-[38px] items-center justify-between border-t border-line">
      <span className="text-text2">{label}</span>
      {children}
    </div>
  );
}
