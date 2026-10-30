// SPDX-License-Identifier: GPL-3.0-or-later
//
// Réglages › Appareils: hardware-wallet accounts (Ledger, Trezor). Public keys only;
// adding goes through the device (HwSetup), removal needs a confirmation.

import { useState } from 'react';
import { call, toIpcError, type WatchOnlyAccount } from '@kyro/shared';
import { useApp } from '../../state/app';
import { DeviceBadge, HwAccountSummary, HwSetup } from '../../components/hw';
import { Dialog } from '../../components/ui/dialog';
import { Badge, Button, Notice, Spinner } from '../../components/ui/primitives';
import { IconPlus, IconTrash, IconWarn } from '../../components/icons';

export function Devices() {
  const { hwAccounts, refreshHwAccounts, activeAccountId, selectAccount, hwOnly } = useApp();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<WatchOnlyAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      await call('hw_account_remove', { accountId: removing.id });
      setRemoving(null);
      await refreshHwAccounts();
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="flex flex-col gap-3.5 rounded-[22px] border border-line bg-card px-[22px] py-[18px]">
        <div className="flex items-center justify-between">
          <span className="text-[15px] font-semibold">Appareils</span>
          <Badge tone="ice">Ledger · Trezor</Badge>
        </div>
        <p className="m-0 text-[13px] leading-[1.55] text-text2">
          Avec un hardware wallet, les clés privées ne quittent jamais l’appareil et chaque transaction se confirme sur son écran, même si cet ordinateur est infecté. Kyro n’enregistre que des clés publiques.
        </p>
        {hwAccounts.length === 0 && <span className="text-[13px] text-faint">Aucun appareil enregistré.</span>}
        <div className="flex flex-col gap-2.5">
          {hwAccounts.map((a) => (
            <HwAccountSummary
              key={a.id}
              acc={a}
              action={
                <div className="flex flex-wrap gap-2">
                  {activeAccountId === a.id ? (
                    <Badge tone="up">Compte actif</Badge>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => selectAccount(a.id)}>
                      Utiliser ce compte
                    </Button>
                  )}
                  <Button size="sm" variant="dangerOutline" onClick={() => setRemoving(a)}>
                    <IconTrash size={13} /> Supprimer
                  </Button>
                </div>
              }
            />
          ))}
        </div>
        {adding ? (
          <div className="rounded-[16px] border border-ice-line bg-bg px-4 py-4">
            <HwSetup
              onCancel={() => setAdding(false)}
              onDone={(acc) => {
                setAdding(false);
                void refreshHwAccounts(acc.id);
              }}
            />
          </div>
        ) : (
          <div>
            <Button variant="primary" onClick={() => setAdding(true)}>
              <IconPlus size={14} /> Ajouter un appareil
            </Button>
          </div>
        )}
      </section>

      <Dialog open={removing !== null} onOpenChange={(v) => (v ? undefined : setRemoving(null))} title="Supprimer ce compte hardware wallet ?" className="w-[520px]">
        {removing && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold">{removing.label}</span>
              <DeviceBadge device={removing.device} model={removing.model} />
            </div>
            <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
              Kyro oublie les clés publiques de ce compte (adresses, historique affiché). <strong className="font-semibold">Tes fonds ne bougent pas</strong> : ils restent contrôlés par ton appareil, et tu pourras rajouter le compte en le rebranchant.
              {hwOnly && hwAccounts.length === 1 ? ' C’est ton seul compte : Kyro reviendra à l’écran d’accueil.' : ''}
            </Notice>
            {error && <Notice tone="error">{error}</Notice>}
            <div className="flex justify-end gap-2">
              <Button variant="primary" onClick={() => setRemoving(null)} disabled={busy}>
                Garder
              </Button>
              <Button variant="dangerOutline" onClick={() => void remove()} disabled={busy}>
                {busy && <Spinner />} Supprimer le compte
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
