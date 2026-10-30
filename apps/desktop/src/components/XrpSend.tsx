// SPDX-License-Identifier: GPL-3.0-or-later
// XRP Ledger pieces of the Send screen (docs/IPC.md §2.6):
// - the destination tag field, ALWAYS visible right under the recipient, mandatory when the
//   destination has lsfRequireDestTag (Rust refuses without it anyway);
// - what Rust will check: activation of a new account (≥ 1 XRP), spendable = balance − reserve;
// - the Rust-decoded payment before the password, and the validation follow-up (xrp_tx_status).

import { useEffect, useState } from 'react';
import type { Currency, XrpAccountInfo } from '@kyro/shared';
import type { XrpAdapter, XrpUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice, Spinner } from './ui/primitives';
import { IconCheck, IconInfo, IconWarn } from './icons';
import { cn } from '../lib/cn';

export const XRP_ACTIVATION = 1_000_000n;
const XRP = (drops: bigint | string) => fmtCrypto(BigInt(drops), 6, 'XRP', 6);

/** The exchange-deposit warning, shown whenever a destination requires a tag. */
export const EXCHANGE_TAG_HINT = 'Les plateformes d’échange exigent presque toujours un tag : sans lui, les fonds peuvent être perdus.';

export function XrpTagField({
  value,
  onChange,
  error,
  dest,
  destLoading,
}: {
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  /** Destination account as Rust reads it; undefined while unknown. */
  dest: XrpAccountInfo | undefined;
  destLoading: boolean;
}) {
  const required = !!dest?.requireDestTag;
  const missing = required && value.trim() === '';
  return (
    <div className={cn('flex flex-col gap-2 rounded-box border px-4 py-3.5', missing || error ? 'border-down/60 bg-down/[.05]' : 'border-ice-line bg-ice/[.05]')}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="xrp-tag" className="text-[13px] font-semibold text-text">
          Tag de destination {required ? <span className="text-down">· obligatoire pour ce destinataire</span> : <span className="font-normal text-mute">· facultatif</span>}
        </label>
        {destLoading && (
          <span className="flex items-center gap-1.5 text-[11px] text-mute">
            <Spinner /> lecture du compte…
          </span>
        )}
      </div>
      <input
        id="xrp-tag"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder="ex. 104857"
        onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, '').slice(0, 10))}
        aria-invalid={missing || !!error}
        className="h-11 rounded-ctl border border-line-3 bg-bg px-3 font-mono text-[16px] font-semibold text-text focus:border-ice-line"
      />
      {error && <span className="text-[12px] text-down">{error}</span>}
      {required ? (
        <span className={cn('flex items-start gap-1.5 text-[12px] leading-[1.45]', missing ? 'text-down' : 'text-warn')}>
          <IconWarn size={13} className="mt-0.5 shrink-0" />
          <span>
            {missing ? 'Ce destinataire exige un tag de destination : sans lui, le paiement est refusé. ' : 'Ce destinataire exige un tag : vérifie qu’il est exact, chiffre par chiffre. '}
            {EXCHANGE_TAG_HINT}
          </span>
        </span>
      ) : value.trim() === '' ? (
        <span className="text-[12px] leading-[1.45] text-mute">Aucun tag. Si tu envoies vers une plateforme d’échange ou un service, il t’a sûrement donné un tag : sans lui, les fonds peuvent être perdus.</span>
      ) : (
        <span className="text-[12px] text-mute">Le tag est public sur le registre ; la fenêtre système l’affiche encadré.</span>
      )}
      {dest && !dest.exists && (
        <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-warn">
          <IconInfo size={13} className="mt-0.5 shrink-0" />
          <span>Ce compte n’existe pas encore sur le XRP Ledger : envoie au moins 1 XRP pour activer ce compte (réserve de base, bloquée chez lui).</span>
        </span>
      )}
    </div>
  );
}

/** Spendable = balance − reserve, with the reserve explained. */
export function XrpSpendable({ account, hidden }: { account: XrpAccountInfo | undefined; hidden: boolean }) {
  if (!account) return null;
  if (!account.exists) {
    return <span className="text-[12px] text-warn">Ton compte XRP n’est pas encore activé : il doit d’abord recevoir au moins 1 XRP.</span>;
  }
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      <strong className="font-semibold text-text2">Solde dépensable : {hidden ? '•••••' : XRP(account.spendable)}</strong> (solde {hidden ? '•••••' : XRP(account.balance)} − réserve {XRP(account.reserve)}). La réserve (1 XRP + 0,2 XRP par objet possédé, ici {account.ownerCount}) reste bloquée sur ton compte tant qu’il existe.
    </span>
  );
}

/** Rust's decoding, before the password: tag framed, activation, fee, reserve, ledger limit. */
export function XrpSummaryView({ u, xrpPrice, currency }: { u: XrpUnsigned; xrpPrice: number | null; currency: Currency }) {
  const s = u.summary;
  const c = u.context;
  // No « 0,0000 € » for a 12-drop fee: fiat only from one cent.
  const fiat = (d: string) => {
    const v = xrpPrice !== null ? (Number(BigInt(d)) / 1e6) * xrpPrice : 0;
    return v >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label="Paiement XRP décodé">
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">Paiement XRP Ledger</span>
        <span className="text-[11px] text-mute">décodé par le coffre</span>
      </div>
      <div className={cn('mx-3 my-2.5 rounded-ctl border-2 px-3 py-2 text-center', s.destinationTag !== null ? 'border-ice-line' : c.destination.requireDestTag ? 'border-down/60' : 'border-warn/50')}>
        <span className="block text-[12px] font-medium text-mute">Tag de destination</span>
        <span className={cn('block font-mono text-[18px] font-semibold', s.destinationTag !== null ? 'text-text' : 'text-warn')}>{s.destinationTag !== null ? s.destinationTag : 'AUCUN'}</span>
      </div>
      {!c.destination.exists && <Line k="Compte destinataire" v="créé par ce paiement (réserve 1 XRP bloquée chez lui)" warn />}
      <Line k="Frais" v={`${XRP(s.fee)}${fiat(s.fee)}`} />
      <Line k="Ton solde" v={XRP(c.account.balance)} />
      <Line k="Réserve bloquée" v={`${XRP(c.account.reserve)} (${XRP(c.reserveBase)} + ${XRP(c.reserveInc)} × ${c.account.ownerCount})`} />
      <Line k="Dépensable" v={XRP(c.account.spendable)} />
      <Line k="Valable jusqu’au registre" v={s.lastLedgerSequence !== null ? `n° ${s.lastLedgerSequence} (≈ 1 min)` : '—'} last />
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

type Status = { state: 'pending' } | { state: 'validated' } | { state: 'failed'; result: string } | { state: 'expired' } | { state: 'error'; message: string };

/**
 * After `xrp_broadcast`: follows `xrp_tx_status` until the payment is in a validated ledger.
 * `tesSUCCESS` → « validée »; any other result → « échouée » (the fee is still taken). Not found
 * after LastLedgerSequence (≈ 1 min) + margin → it can no longer be included.
 */
export function XrpTxStatusLine({ adapter, hash, recipient, onValidated }: { adapter: XrpAdapter; hash: string; recipient: string; onValidated?: () => void }) {
  const [status, setStatus] = useState<Status>({ state: 'pending' });
  useEffect(() => {
    let alive = true;
    const started = Date.now();
    let timer = 0;
    const tick = async () => {
      try {
        const s = await adapter.txStatus(hash);
        if (!alive) return;
        if (s.validated) {
          if (s.result === 'tesSUCCESS') {
            setStatus({ state: 'validated' });
            onValidated?.();
          } else setStatus({ state: 'failed', result: s.result || 'inconnu' });
          return;
        }
        if (Date.now() - started > 120_000) {
          setStatus({ state: 'expired' });
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
        <Spinner /> En attente de validation par le registre XRP (quelques secondes)…
      </div>
    );
  }
  if (status.state === 'validated') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        <strong className="font-semibold">Validée :</strong> le paiement est inclus dans un registre validé (tesSUCCESS). {shortAddress(recipient)} a reçu les fonds.
      </Notice>
    );
  }
  if (status.state === 'failed') {
    return (
      <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />} className="w-full text-left">
        <strong className="font-semibold">Échouée ({status.result}) :</strong> le registre a refusé le paiement, rien n’a été livré. Les frais (quelques drops) sont tout de même prélevés.
      </Notice>
    );
  }
  if (status.state === 'expired') {
    return (
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
        Toujours pas validée après 2 minutes : elle a dépassé son registre limite et ne sera plus incluse. Vérifie l’historique avant de renvoyer.
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      Suivi de la validation impossible pour l’instant : {status.message}
    </Notice>
  );
}
