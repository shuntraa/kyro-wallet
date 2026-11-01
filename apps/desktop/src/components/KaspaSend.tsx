// SPDX-License-Identifier: GPL-3.0-or-later
// Kaspa pieces of the Send screen (docs/IPC.md §2.11):
// - what Rust will check before building: 0.2 KAS minimum (KIP-9 storage mass), spendable coins;
// - the Rust-decoded payment before the password (outputs, change, fee, mass breakdown);
// - the acceptance follow-up (`kas_tx_status`).

import { useEffect, useState } from 'react';
import type { Currency, KaspaAccountInfo } from '@kyro/shared';
import type { KaspaAdapter, KaspaUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice, Spinner } from './ui/primitives';
import { IconCheck, IconWarn } from './icons';
import { cn } from '../lib/cn';

const KAS = (sompi: bigint | string) => fmtCrypto(BigInt(sompi), 8, 'KAS', 8);

/** Spendable coins of the whole account (20 receive + 20 change addresses). */
export function KaspaSpendable({ account, hidden }: { account: KaspaAccountInfo | undefined | null; hidden: boolean }) {
  if (!account) return null;
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      Dépensable : {hidden ? '•••••' : KAS(account.spendable)} ({account.utxoCount} pièce{account.utxoCount > 1 ? 's' : ''} sur tes {account.scanned} premières adresses de réception et de monnaie). Minimum 0,2 KAS par envoi : la masse de stockage de Kaspa (KIP-9) rend les petites sorties non standard.
    </span>
  );
}

/** Rust's decoding, before the password: each output, change, fee and the mass behind it. */
export function KaspaSummaryView({ u, kasPrice, currency }: { u: KaspaUnsigned; kasPrice: number | null; currency: Currency }) {
  const s = u.summary;
  const fiat = (v: string) => {
    const f = kasPrice !== null ? (Number(BigInt(v)) / 1e8) * kasPrice : 0;
    return f >= 0.01 ? ` · ${fmtFiat(f, currency)}` : '';
  };
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label="Transaction Kaspa décodée">
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">Transaction Kaspa</span>
        <span className="text-[11px] text-mute">décodée par le coffre</span>
      </div>
      {s.outputs.map((o, i) => (
        <Line key={i} k={o.isChange ? 'Monnaie (revient chez toi)' : 'Destinataire'} v={`${KAS(o.amount)} · ${o.address ? shortAddress(o.address) : 'script inconnu'}`} warn={o.kind !== 'address'} />
      ))}
      {!s.hasChange && <Line k="Monnaie" v="aucune : le petit reste part en frais" warn />}
      <Line k="Frais" v={`${KAS(s.fee)}${fiat(s.fee)}`} warn={s.warnings.some((w) => w.kind === 'highFee')} />
      <Line k="Masse" v={`${s.mass.total} g (calcul ${s.mass.compute}, stockage ${s.mass.storage})`} />
      <Line k="Minimum de relais" v={KAS(s.minimumFee)} />
      <Line k="Entrées" v={`${s.inputs} pièce${s.inputs > 1 ? 's' : ''} · ${KAS(s.inputTotal)}`} last />
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

type Status = { state: 'pending' } | { state: 'accepted' } | { state: 'unknown' } | { state: 'error'; message: string };

/** After `kas_broadcast`: follows `kas_tx_status` until the transaction is accepted (seconds). */
export function KaspaTxStatusLine({ adapter, txid, onAccepted }: { adapter: KaspaAdapter; txid: string; onAccepted?: () => void }) {
  const [status, setStatus] = useState<Status>({ state: 'pending' });
  useEffect(() => {
    let alive = true;
    const started = Date.now();
    let timer = 0;
    const tick = async () => {
      try {
        const s = await adapter.txStatus(txid);
        if (!alive) return;
        if (s.accepted) {
          setStatus({ state: 'accepted' });
          onAccepted?.();
          return;
        }
        if (Date.now() - started > 120_000) {
          setStatus({ state: 'unknown' });
          return;
        }
      } catch (e) {
        if (!alive) return;
        setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
      timer = window.setTimeout(() => void tick(), 2_000);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [adapter, txid]);

  if (status.state === 'pending') {
    return (
      <div role="status" className="flex w-full items-center gap-2 rounded-ctl border border-line bg-raised px-3.5 py-2.5 text-[13px] text-text2">
        <Spinner /> En attente d’acceptation par le réseau Kaspa (quelques secondes)…
      </div>
    );
  }
  if (status.state === 'accepted') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        <strong className="font-semibold">Acceptée :</strong> la transaction est incluse dans la chaîne Kaspa.
      </Notice>
    );
  }
  if (status.state === 'unknown') {
    return (
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
        Toujours pas acceptée après 2 minutes selon l’indexeur : vérifie l’historique avant de renvoyer.
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      Suivi de l’acceptation impossible pour l’instant : {status.message}
    </Notice>
  );
}
