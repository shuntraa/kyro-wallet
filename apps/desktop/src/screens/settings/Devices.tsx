// SPDX-License-Identifier: GPL-3.0-or-later
//
// Réglages › Appareils: hardware-wallet accounts (Ledger, Trezor). Public keys only;
// adding goes through the device (HwSetup), removal needs a confirmation.

import { useState } from 'react';
import { call, toIpcError, type HwThpPairing, type WatchOnlyAccount } from '@kyro/shared';
import { useAsync } from '../../lib/useAsync';
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
      <ThpPairings />

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

/**
 * Trezor Safe 7 (THP) pairings of this installation. Forgetting one removes Kyro's identifier
 * (the next connection asks for a new code); « Tout oublier » also drops Kyro's THP key. The
 * device keeps « Kyro Wallet » in its own list until it is reset.
 */
function ThpPairings() {
  const list = useAsync(() => call('hw_thp_pairings'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const forget = async (key?: string) => {
    setBusy(key ?? 'all');
    setError(null);
    try {
      await call('hw_thp_forget', key ? { key } : {});
      list.reload();
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(null);
    }
  };
  const items: HwThpPairing[] = list.data ?? [];
  if (!list.data && !list.error) return null;
  return (
    <section className="flex flex-col gap-3 rounded-[22px] border border-line bg-card px-[22px] py-[18px]">
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-semibold">Appareils Trezor appairés</span>
        <Badge>Trezor Safe 7 · canal chiffré</Badge>
      </div>
      <p className="m-0 text-[13px] leading-[1.55] text-text2">
        Un Trezor Safe 7 s’appaire une fois avec Kyro (code à 6 chiffres affiché sur l’appareil), puis la connexion se fait sur un canal chiffré. « Oublier » efface l’appairage dans Kyro : la prochaine connexion demandera un nouveau code. <strong className="font-semibold text-text">L’appareil, lui, garde Kyro dans sa liste</strong> jusqu’à sa réinitialisation.
      </p>
      {list.error && <Notice tone="error">{list.error.message}</Notice>}
      {list.data && items.length === 0 && <span className="text-[13px] text-faint">Aucun Trezor Safe 7 appairé.</span>}
      {items.map((p) => (
        <div key={p.key} className="flex items-center justify-between gap-3 rounded-[14px] border border-line bg-raised px-4 py-2.5">
          <span className="flex min-w-0 flex-col">
            <span className="text-[13px] font-semibold">{p.model === 'T3W1' ? 'Trezor Safe 7' : p.model}</span>
            <span className="truncate font-mono text-[11px] text-mute">
              clé {p.key.slice(0, 12)}…{p.key.slice(-6)} · appairé le {new Date(p.added * 1000).toLocaleDateString('fr-FR')}
            </span>
          </span>
          <Button size="sm" variant="dangerOutline" onClick={() => void forget(p.key)} disabled={busy !== null}>
            {busy === p.key && <Spinner />} Oublier
          </Button>
        </div>
      ))}
      {items.length > 0 && (
        <div>
          <Button size="sm" variant="dangerOutline" onClick={() => void forget()} disabled={busy !== null}>
            {busy === 'all' && <Spinner />} Tout oublier
          </Button>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}
