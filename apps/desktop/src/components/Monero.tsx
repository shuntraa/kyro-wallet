// SPDX-License-Identifier: GPL-3.0-or-later
// Monero pieces of the app (docs/IPC.md §2.11):
// - the scan status: Rust downloads the blocks and scans them on this machine (no key sent to
//   the node), in a background task started here and polled while it runs;
// - Receive: primary address + subaddresses handed out one by one (recommended: one per payer);
// - Send: Rust's decoding of the destination, then of the built transfer, before the password;
// - Réglages › Sécurité: the 25-word Monero seed (native window only) and the restore height.

import { useEffect, useRef, useState } from 'react';
import { toIpcError, type Currency } from '@kyro/shared';
import { xmrDestinationLabel, xmrHeightAt, XMR_DECIMALS, XMR_LOCK_BLOCKS, type XmrAdapter, type XmrDestination, type XmrStatus, type XmrSubaddress, type XmrUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, fmtNumber } from '../lib/format';
import { cn } from '../lib/cn';
import { AddressBlocks, CopyButton, PasswordField } from './kit';
import { Dialog } from './ui/dialog';
import { Button, Input, Notice, Spinner } from './ui/primitives';
import { IconInfo, IconWarn } from './icons';

const XMR = (pico: bigint | string) => fmtCrypto(BigInt(pico), XMR_DECIMALS, 'XMR', 6);
const fmtDate = (unixSecs: number) => new Date(unixSecs * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Scan status of the active Monero account. Starts the background scan once when mounted (and
 * on `sync()`), polls `xmr_status` every 2 s while it runs, every 60 s otherwise.
 */
export function useXmrStatus(adapter: XmrAdapter | null | undefined): { status: XmrStatus | null; error: string | null; sync: () => void; reload: () => void } {
  const [status, setStatus] = useState<XmrStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const started = useRef<XmrAdapter | null>(null);
  const running = status?.running ?? false;

  useEffect(() => {
    if (!adapter) return;
    let alive = true;
    const first = started.current !== adapter;
    started.current = adapter;
    (first ? adapter.sync() : adapter.status())
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(toIpcError(e).message));
    return () => {
      alive = false;
    };
  }, [adapter, tick]);

  useEffect(() => {
    if (!adapter) return;
    const id = window.setInterval(() => setTick((t) => t + 1), running ? 2_000 : 60_000);
    return () => window.clearInterval(id);
  }, [adapter, running]);

  return {
    status,
    error,
    sync: () => {
      if (!adapter) return;
      adapter
        .sync()
        .then((s) => setStatus(s))
        .catch((e: unknown) => setError(toIpcError(e).message));
    },
    reload: () => setTick((t) => t + 1),
  };
}

/** Progress of the scan, or what was scanned and when. */
export function XmrSyncLine({ status, error, onRetry, className }: { status: XmrStatus | null; error: string | null; onRetry?: () => void; className?: string }) {
  if (error && !status) {
    return (
      <span className={cn('flex items-center gap-2 text-[12px] text-down', className)}>
        Monero : {error}
        {onRetry && (
          <button type="button" className="underline" onClick={onRetry}>
            Réessayer
          </button>
        )}
      </span>
    );
  }
  if (!status) {
    return (
      <span className={cn('flex items-center gap-2 text-[12px] text-mute', className)}>
        <Spinner /> Lecture de l’état du scan Monero…
      </span>
    );
  }
  const pct = Math.round(status.progress * 100);
  const done = !status.running && status.restoreHeight !== null && status.progress >= 1;
  return (
    <div className={cn('flex flex-col gap-1.5 text-[12px]', className)} aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-text2">
          {status.running && <Spinner />}
          {status.running ? `Scan des blocs Monero sur ta machine… ${pct} %` : done ? 'Portefeuille Monero à jour' : status.restoreHeight === null ? 'Scan Monero pas encore lancé' : `Scan interrompu à ${pct} %`}
        </span>
        <span className="font-mono text-[11px] text-mute">
          {status.tip !== null ? `bloc ${fmtNumber(status.scanned, 0)} / ${fmtNumber(status.tip, 0)}` : ''}
        </span>
      </div>
      {(status.running || !done) && status.restoreHeight !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progression du scan Monero">
          <div className="h-full bg-ice transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}
      {status.error && (
        <span className="flex items-center gap-2 text-down">
          {status.error}
          {onRetry && !status.running && (
            <button type="button" className="underline" onClick={onRetry}>
              Relancer
            </button>
          )}
        </span>
      )}
      {!status.running && !status.error && onRetry && done && (
        <span className="text-mute">
          Nœud {status.node || '—'} : il fournit les blocs, Kyro les scanne lui-même (aucune clé envoyée).{' '}
          <button type="button" className="underline" onClick={onRetry}>
            Actualiser
          </button>
        </span>
      )}
      {status.ignoredOutputs > 0 && <span className="text-warn">{status.ignoredOutputs} sortie(s) ignorée(s) : clé déjà reçue (bug « burning ») ou blocage supplémentaire.</span>}
    </div>
  );
}

/** « dont X XMR bloqués » under a Monero balance. */
export function XmrLockedNote({ status, hidden }: { status: XmrStatus | null; hidden: boolean }) {
  if (!status) return null;
  const locked = BigInt(status.balance) - BigInt(status.unlocked);
  if (locked <= 0n) return null;
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      Dont <strong className="font-semibold text-text2">{hidden ? '•••••' : XMR(locked)}</strong> bloqués : un montant reçu attend {XMR_LOCK_BLOCKS} confirmations (≈ 20 min) avant de pouvoir être dépensé. Disponible : {hidden ? '•••••' : XMR(status.unlocked)}.
    </span>
  );
}

/** Rust's decoding of the typed destination. */
export function XmrDestinationLine({ dest, error, loading }: { dest: XmrDestination | undefined; error: string | null; loading: boolean }) {
  if (loading && !dest) {
    return (
      <span className="flex items-center gap-2 text-[12px] text-mute">
        <Spinner /> Vérification de l’adresse par le coffre…
      </span>
    );
  }
  if (error) return <span className="text-[12px] text-down">{error}</span>;
  if (!dest) return null;
  return (
    <span className={cn('flex items-start gap-1.5 text-[12px] leading-[1.45]', dest.kind === 'integrated' ? 'text-warn' : 'text-mute')}>
      <IconInfo size={13} className="mt-0.5 shrink-0" />
      <span>
        <strong className="font-semibold text-text2">{xmrDestinationLabel(dest)}</strong>
        {dest.kind === 'integrated' ? ' : vérifie que cet ID de paiement est bien celui que la plateforme t’a donné.' : ' (décodée par le coffre).'}
      </span>
    </span>
  );
}

/** The transfer as Rust built it, before the password. */
export function XmrSummaryView({ u, xmrPrice, currency }: { u: XmrUnsigned; xmrPrice: number | null; currency: Currency }) {
  const s = u.summary;
  const fiat = (p: string) => {
    const v = xmrPrice !== null ? (Number(BigInt(p)) / 1e12) * xmrPrice : 0;
    return v >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label="Transfert Monero construit par le coffre">
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">Transfert Monero</span>
        <span className="text-[11px] text-mute">construit par le coffre</span>
      </div>
      <Line k="Destinataire" v={xmrDestinationLabel(s.destination)} warn={s.destination.kind === 'integrated'} />
      <Line k="Montant" v={`${XMR(s.amount)}${fiat(s.amount)}`} />
      <Line k="Frais réseau" v={`${XMR(s.fee)}${fiat(s.fee)}`} />
      <Line k="Monnaie (vers ton adresse principale)" v={XMR(s.change)} />
      <Line k="Dépensé" v={`${XMR(s.inputsTotal)} · ${s.inputCount} sortie${s.inputCount > 1 ? 's' : ''}`} />
      <Line k="Anneaux" v={`${s.ringSize} membres (ta sortie + ${s.ringSize - 1} leurres)`} last />
      {s.requiresExtraConfirmation && (
        <div className="border-t border-line px-3.5 py-2 text-warn">
          Une 2ᵉ fenêtre te demandera de confirmer :{' '}
          {s.warnings.map((w) => ({ integratedAddress: 'adresse intégrée', highFee: 'frais élevés', feeAboveAmount: 'frais supérieurs au montant', ownAddress: 'envoi à toi-même' })[w]).join(', ')}.
        </div>
      )}
    </div>
  );
}

function Line({ k, v, warn, last }: { k: string; v: string; warn?: boolean; last?: boolean }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-3.5 py-1.5', !last && 'border-b border-line')}>
      <span className="text-text2">{k}</span>
      <span className={cn('text-right', warn ? 'text-warn' : 'text-text2')}>{v}</span>
    </div>
  );
}

/** Notes shown on the Send screen for Monero. */
export function XmrSendNotes() {
  return (
    <span className="flex items-start gap-1.5 text-[12px] leading-[1.5] text-mute">
      <IconWarn size={13} className="mt-0.5 shrink-0 text-warn" />
      <span>
        Un transfert Monero ne peut pas être annulé une fois publié. Le coffre choisit tes sorties, 15 leurres par sortie et les frais ; la monnaie revient sur ton adresse principale et reste bloquée {XMR_LOCK_BLOCKS} blocs (≈ 20 min).
      </span>
    </span>
  );
}

/** Receive: subaddresses handed out by Rust, with what each received. */
export function XmrReceivePanel({ adapter, hidden }: { adapter: XmrAdapter; hidden: boolean }) {
  const [list, setList] = useState<XmrSubaddress[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { status, error: statusError, sync } = useXmrStatus(adapter);
  useEffect(() => {
    let alive = true;
    adapter.backend
      .subaddresses()
      .then((l) => alive && setList(l))
      .catch((e: unknown) => alive && setError(toIpcError(e).message));
    return () => {
      alive = false;
    };
  }, [adapter]);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await adapter.backend.newSubaddress();
      setList((l) => [...(l ?? []), s]);
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };
  const subs = (list ?? []).filter((s) => s.index > 0);
  return (
    <div className="flex flex-col gap-3">
      <XmrSyncLine status={status} error={statusError} onRetry={sync} />
      {status && status.restoreHeight !== null && (
        <span className="text-[12px] leading-[1.5] text-mute">
          Kyro scanne à partir du bloc {fmtNumber(status.restoreHeight, 0)}
          {status.tip !== null && status.tipTime !== null ? ` (≈ ${fmtDate(status.tipTime - (status.tip - status.restoreHeight) * 120)})` : ''}. Des XMR reçus avant ne s’affichent pas : choisis une hauteur plus ancienne dans Réglages › Sécurité.
        </span>
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow">Sous-adresses</span>
        <Button size="md" onClick={() => void create()} disabled={busy}>
          {busy && <Spinner />} Nouvelle sous-adresse
        </Button>
      </div>
      <span className="text-[12px] leading-[1.5] text-mute">
        Recommandé : une sous-adresse par personne ou par service qui te paie. Toutes arrivent dans ce même portefeuille, mais personne ne peut les relier entre elles ni à ton adresse principale.
      </span>
      {error && <Notice tone="error">{error}</Notice>}
      {subs.length === 0 && list && <span className="text-[12px] text-faint">Aucune sous-adresse pour l’instant.</span>}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {subs
          .slice()
          .reverse()
          .map((s) => (
            <li key={s.index} className="flex flex-col gap-1.5 rounded-box border border-line bg-bg px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <span className="font-medium text-text2">Sous-adresse n° {s.index}</span>
                <span className="text-mute">{BigInt(s.received) > 0n ? `reçu : ${hidden ? '•••••' : XMR(s.received)}` : 'rien reçu'}</span>
              </div>
              <AddressBlocks address={s.address} size="sm" />
              <CopyButton text={s.address} label="Copier" className="self-start" />
            </li>
          ))}
      </ul>
    </div>
  );
}

/** Réglages › Sécurité: 25-word Monero seed (native window) and restore height. */
export function XmrWalletSection({ adapter }: { adapter: XmrAdapter | null }) {
  const [open, setOpen] = useState<'seed' | 'height' | null>(null);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<'height' | 'date'>('date');
  const [value, setValue] = useState('');
  const { status } = useXmrStatus(adapter);
  if (!adapter) return null;

  const close = () => {
    setOpen(null);
    setPw('');
    setError(null);
    setValue('');
  };
  const showSeed = async () => {
    setBusy(true);
    setError(null);
    try {
      await adapter.backend.showSeed(pw);
      setPw('');
      setNotice('La fenêtre système est fermée : la phrase Monero n’est plus affichée.');
      setOpen(null);
    } catch (e) {
      const err = toIpcError(e);
      setError(err.code === 'USER_REJECTED' ? 'Affichage annulé dans la fenêtre système.' : err.message);
    } finally {
      setBusy(false);
    }
  };
  const target = (() => {
    const v = value.trim();
    if (!v) return null;
    if (mode === 'height') return /^\d{1,9}$/.test(v) ? Number(v) : null;
    const t = Date.parse(v);
    if (!Number.isFinite(t) || !status?.tip || !status.tipTime) return null;
    return xmrHeightAt(Math.floor(t / 1000), status.tip, status.tipTime);
  })();
  const setHeight = async () => {
    if (target === null) return;
    setBusy(true);
    setError(null);
    try {
      await adapter.backend.setRestoreHeight(target);
      await adapter.sync();
      setNotice(`Nouveau scan lancé à partir du bloc ${fmtNumber(target, 0)}.`);
      close();
    } catch (e) {
      setError(toIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-panel border border-line bg-card px-[22px] py-[18px]">
      <div className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] font-semibold">Portefeuille Monero</span>
          <span className="text-[12px] leading-[1.5] text-mute">
            Calculé depuis ta phrase de récupération (clé m/44’/128’/n’/0/0). Sa phrase Monero de 25 mots le restaure dans Monero GUI, Feather ou Cake Wallet.
            {status && status.restoreHeight !== null ? ` Scan à partir du bloc ${fmtNumber(status.restoreHeight, 0)}.` : ''}
          </span>
        </div>
        <Button variant="dangerOutline" size="md" onClick={() => setOpen('seed')}>
          Phrase Monero
        </Button>
        <Button variant="outline" size="md" onClick={() => setOpen('height')}>
          Hauteur de restauration
        </Button>
      </div>
      {notice && <Notice tone="info">{notice}</Notice>}
      <Dialog open={open === 'seed'} onOpenChange={(v) => (v ? setOpen('seed') : close())} title="Afficher la phrase Monero (25 mots)" className="w-[600px]">
        <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
          Quiconque voit ces 25 mots peut prendre tes XMR. Vérifie que personne ne regarde ton écran et qu’aucun partage d’écran n’est actif.
        </Notice>
        <p className="m-0 text-[13px] leading-[1.55] text-text2">Après ton mot de passe, Kyro te demande une confirmation dans une fenêtre du système, puis y affiche les mots. L’interface ne les reçoit jamais.</p>
        <PasswordField id="xmr-seed-pw" value={pw} onChange={setPw} autoFocus onEnter={() => pw && void showSeed()} />
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Annuler</Button>
          <Button variant="danger" disabled={!pw || busy} onClick={() => void showSeed()}>
            {busy && <Spinner />} {busy ? 'Fenêtre système ouverte…' : 'Afficher la phrase'}
          </Button>
        </div>
      </Dialog>
      <Dialog open={open === 'height'} onOpenChange={(v) => (v ? setOpen('height') : close())} title="Hauteur de restauration Monero" className="w-[560px]">
        <p className="m-0 text-[13px] leading-[1.55] text-text2">
          Kyro ne voit que les XMR reçus à partir de ce bloc. Si cette phrase a reçu des XMR plus tôt (autre portefeuille, autre appareil), choisis une date plus ancienne : tout est scanné à nouveau, ce qui peut prendre du temps (≈ 720 blocs par jour).
        </p>
        <div className="flex gap-2">
          <Button size="md" variant={mode === 'date' ? 'primary' : 'outline'} onClick={() => setMode('date')}>
            Une date
          </Button>
          <Button size="md" variant={mode === 'height' ? 'primary' : 'outline'} onClick={() => setMode('height')}>
            Un numéro de bloc
          </Button>
        </div>
        <Input type={mode === 'date' ? 'date' : 'text'} inputMode={mode === 'height' ? 'numeric' : undefined} value={value} onChange={(e) => setValue(e.target.value)} placeholder={mode === 'height' ? 'ex. 3200000' : ''} aria-label={mode === 'date' ? 'Date de restauration' : 'Bloc de restauration'} />
        <span className="text-[12px] text-mute">
          {target !== null ? `Bloc de départ : ${fmtNumber(target, 0)}${mode === 'date' ? ' (estimé : 1 bloc toutes les 2 min, avec la hauteur actuelle du nœud)' : ''}.` : mode === 'date' && !status?.tip ? 'Hauteur actuelle inconnue : attends la fin de la lecture du nœud.' : ' '}
        </span>
        {status?.running && <Notice tone="warn">Un scan est en cours : attends qu’il se termine.</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Annuler</Button>
          <Button variant="primary" disabled={target === null || busy || !!status?.running} onClick={() => void setHeight()}>
            {busy && <Spinner />} Scanner à partir de là
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
