// SPDX-License-Identifier: GPL-3.0-or-later
// NEAR pieces of the Send screen (docs/IPC.md §2.11):
// - what the receiver is (implicit / named / Ethereum-style) and whether it exists, as Rust reads
//   it: a named account must exist, an implicit one is created by the transfer;
// - spendable = balance − storage reserve;
// - the Rust-decoded transfer before the password (fees are NOT in a NEAR transaction: Kyro shows
//   an estimate and the bound it checked), and the execution follow-up (near_tx_status).

import { useEffect, useState } from 'react';
import type { Currency, NearAccountInfo } from '@kyro/shared';
import { nearAccountKind, type NearAdapter, type NearUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice, Spinner } from './ui/primitives';
import { IconCheck, IconInfo, IconWarn } from './icons';
import { cn } from '../lib/cn';

const NEAR = (yocto: bigint | string) => fmtCrypto(BigInt(yocto), 24, 'NEAR', 6);

/** Kind and existence of the receiver, under the recipient field. */
export function NearReceiverLine({ id, info, loading }: { id: string; info: NearAccountInfo | undefined; loading: boolean }) {
  const kind = nearAccountKind(id);
  if (!kind) return null;
  if (loading && !info) {
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-mute">
        <Spinner /> Lecture du compte NEAR…
      </span>
    );
  }
  if (!info) return null;
  if (kind === 'named') {
    return info.exists ? (
      <span className="text-[12px] text-mute">Compte nommé NEAR existant{info.hasContract ? ' (un contrat y est déployé)' : ''}.</span>
    ) : (
      <span className="text-[12px] text-down">Ce compte nommé n’existe pas : un transfert vers lui échouerait (et les frais seraient perdus). Vérifie l’orthographe (.near / .testnet).</span>
    );
  }
  if (kind === 'ethImplicit') {
    return info.exists ? (
      <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-warn">
        <IconWarn size={13} className="mt-0.5 shrink-0" />
        <span>Compte NEAR de style Ethereum (0x…), contrôlé par une clé Ethereum. Une adresse de dépôt EVM d’une plateforme n’est PAS un compte NEAR : une 2ᵉ confirmation te sera demandée.</span>
      </span>
    ) : (
      <span className="text-[12px] text-down">Ce compte de style Ethereum n’existe pas sur NEAR : Kyro ne le crée pas.</span>
    );
  }
  return info.exists ? (
    <span className="text-[12px] text-mute">Compte implicite NEAR existant (64 caractères : la clé publique du destinataire).</span>
  ) : (
    <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-warn">
      <IconInfo size={13} className="mt-0.5 shrink-0" />
      <span>Ce compte implicite n’existe pas encore : ce transfert le crée (un peu plus de frais). Vérifie-le caractère par caractère : une faute de frappe crée un compte que personne ne contrôle.</span>
    </span>
  );
}

/** A receiver that cannot receive (named / 0x… account that does not exist). */
export function nearReceiverBlocked(id: string, info: NearAccountInfo | undefined): boolean {
  const kind = nearAccountKind(id);
  return !!info && !info.exists && kind !== 'implicit';
}

/** Spendable = balance − storage reserve. */
export function NearSpendable({ account, hidden }: { account: NearAccountInfo | undefined; hidden: boolean }) {
  if (!account) return null;
  if (!account.exists) {
    return <span className="text-[12px] text-warn">Ton compte NEAR n’existe pas encore : il est créé par le premier NEAR que tu reçois.</span>;
  }
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      <strong className="font-semibold text-text2">Solde dépensable : {hidden ? '•••••' : NEAR(account.spendable)}</strong> (solde {hidden ? '•••••' : NEAR(account.balance)} − réserve de stockage {hidden ? '•••••' : NEAR(account.storageReserve)}). La réserve paie les {account.storageUsage} octets que ton compte occupe sur la chaîne ; les frais (≈ 0,00005 NEAR) s’ajoutent au montant.
    </span>
  );
}

/** Rust's decoding, before the password. */
export function NearSummaryView({ u, nearPrice, currency }: { u: NearUnsigned; nearPrice: number | null; currency: Currency }) {
  const s = u.summary;
  const c = u.context;
  const fiat = (y: string) => {
    const v = nearPrice !== null ? (Number(BigInt(y) / 10n ** 12n) / 1e12) * nearPrice : 0;
    return v >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label="Transfert NEAR décodé">
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">Transfert NEAR</span>
        <span className="text-[11px] text-mute">décodé par le coffre</span>
      </div>
      <Line k="Destinataire" v={`${s.receiverKind === 'named' ? 'compte nommé' : s.receiverKind === 'implicit' ? 'compte implicite' : 'compte de style Ethereum'}${c.createsAccount ? ', créé par ce transfert' : ''}`} warn={c.createsAccount || s.receiverKind === 'ethImplicit'} />
      <Line k="Frais estimés" v={`${NEAR(c.feeEstimate)}${fiat(c.feeEstimate)}`} />
      <Line k="Frais au plus" v={`${NEAR(c.feeBound)} (borne vérifiée par Kyro)`} />
      <Line k="Ton solde" v={NEAR(c.account.balance)} />
      <Line k="Réserve de stockage" v={NEAR(c.account.storageReserve)} />
      <Line k="Dépensable" v={NEAR(c.account.spendable)} />
      <Line k="Clé · nonce" v={`${shortAddress(s.publicKey)} · ${s.nonce}`} />
      <Line k="Hash" v={shortAddress(s.hash)} last />
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

type Status = { state: 'pending' } | { state: 'success' } | { state: 'failed'; message: string } | { state: 'late' } | { state: 'error'; message: string };

/** After `near_broadcast`: follows `near_tx_status` until the transfer is executed. */
export function NearTxStatusLine({ adapter, hash, recipient, onDone }: { adapter: NearAdapter; hash: string; recipient: string; onDone?: () => void }) {
  const [status, setStatus] = useState<Status>({ state: 'pending' });
  useEffect(() => {
    let alive = true;
    const started = Date.now();
    let timer = 0;
    const tick = async () => {
      try {
        const s = await adapter.txStatus(hash);
        if (!alive) return;
        if (s.status === 'success') {
          setStatus({ state: 'success' });
          onDone?.();
          return;
        }
        if (s.status === 'failure') {
          setStatus({ state: 'failed', message: s.message });
          return;
        }
        if (Date.now() - started > 120_000) {
          setStatus({ state: 'late' });
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
  }, [adapter, hash]);

  if (status.state === 'pending') {
    return (
      <div role="status" className="flex w-full items-center gap-2 rounded-ctl border border-line bg-raised px-3.5 py-2.5 text-[13px] text-text2">
        <Spinner /> En attente d’exécution sur NEAR (quelques secondes)…
      </div>
    );
  }
  if (status.state === 'success') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        <strong className="font-semibold">Exécuté :</strong> {shortAddress(recipient)} a reçu les fonds.
      </Notice>
    );
  }
  if (status.state === 'failed') {
    return (
      <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />} className="w-full text-left">
        <strong className="font-semibold">Échoué :</strong> le réseau a refusé le transfert{status.message ? ` (${status.message})` : ''}. Le montant revient sur ton compte ; les frais sont prélevés.
      </Notice>
    );
  }
  if (status.state === 'late') {
    return (
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
        Toujours pas exécuté après 2 minutes. Vérifie l’historique avant de renvoyer : la transaction reste valable environ 24 h.
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      Suivi impossible pour l’instant : {status.message}
    </Notice>
  );
}
