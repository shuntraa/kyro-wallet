// SPDX-License-Identifier: GPL-3.0-or-later
// Stellar pieces of the Send screen (docs/IPC.md §2.11):
// - the memo field, ALWAYS visible right under the recipient (text / identifiant / hash),
//   mandatory when the destination requires one (SEP-0029; Rust refuses without it anyway);
// - what Rust will check: creation of a new account (≥ 1 XLM, CreateAccount), spendable =
//   balance − reserve (the reserve explained);
// - the Rust-decoded transaction before the password, and the inclusion follow-up.

import { useEffect, useState } from 'react';
import type { Currency, StellarAccountInfo, StellarMemoSpec } from '@kyro/shared';
import type { StellarAdapter, StellarUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice, Spinner } from './ui/primitives';
import { IconCheck, IconInfo, IconWarn } from './icons';
import { cn } from '../lib/cn';

/** 2 × base reserve (0.5 XLM): the minimum to create an account. */
export const XLM_ACTIVATION = 10_000_000n;
const XLM = (stroops: bigint | string) => fmtCrypto(BigInt(stroops), 7, 'XLM', 7);

export type StellarMemoKind = StellarMemoSpec['kind'];

const KINDS: Array<{ value: StellarMemoKind; label: string; placeholder: string }> = [
  { value: 'id', label: 'Identifiant', placeholder: 'ex. 804539585' },
  { value: 'text', label: 'Texte', placeholder: '28 octets au plus' },
  { value: 'hash', label: 'Hash', placeholder: '64 caractères hexadécimaux' },
];

export function StellarMemoField({
  kind,
  onKind,
  value,
  onChange,
  error,
  dest,
  destLoading,
}: {
  kind: StellarMemoKind;
  onKind: (k: StellarMemoKind) => void;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  /** Destination account as Rust reads it; undefined while unknown. */
  dest: StellarAccountInfo | undefined;
  destLoading: boolean;
}) {
  const required = !!dest?.memoRequired;
  const empty = value.trim() === '';
  const missing = required && empty;
  const k = KINDS.find((x) => x.value === kind) ?? KINDS[0]!;
  return (
    <div className={cn('flex flex-col gap-2 rounded-box border px-4 py-3.5', missing || error ? 'border-down/60 bg-down/[.05]' : 'border-ice-line bg-ice/[.05]')}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="xlm-memo" className="text-[13px] font-semibold text-text">
          Mémo {required ? <span className="text-down">· obligatoire pour ce destinataire</span> : <span className="font-normal text-mute">· facultatif</span>}
        </label>
        {destLoading && (
          <span className="flex items-center gap-1.5 text-[11px] text-mute">
            <Spinner /> lecture du compte…
          </span>
        )}
      </div>
      <div role="radiogroup" aria-label="Type de mémo" className="flex gap-1.5">
        {KINDS.map((x) => (
          <button
            key={x.value}
            type="button"
            role="radio"
            aria-checked={kind === x.value}
            onClick={() => onKind(x.value)}
            className={cn('press h-7 rounded-[5px] border px-2.5 text-[12px] font-medium', kind === x.value ? 'border-ice/40 bg-ice/[.1] text-ice-text' : 'border-line-2 text-text2 hover:border-line-3')}
          >
            {x.label}
          </button>
        ))}
      </div>
      <input
        id="xlm-memo"
        type="text"
        inputMode={kind === 'id' ? 'numeric' : 'text'}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={k.placeholder}
        onChange={(e) => onChange(kind === 'id' ? e.target.value.replace(/[^\d]/g, '').slice(0, 20) : kind === 'hash' ? e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 64) : e.target.value)}
        aria-invalid={missing || !!error}
        className="h-11 rounded-ctl border border-line-3 bg-bg px-3 font-mono text-[15px] font-semibold text-text focus:border-ice-line"
      />
      {error && <span className="text-[12px] text-down">{error}</span>}
      {required ? (
        <span className={cn('flex items-start gap-1.5 text-[12px] leading-[1.45]', missing ? 'text-down' : 'text-warn')}>
          <IconWarn size={13} className="mt-0.5 shrink-0" />
          <span>
            {missing ? 'Ce destinataire exige un mémo : sans lui, le coffre refuse de construire l’envoi. ' : 'Ce destinataire exige un mémo : vérifie qu’il est exact, caractère par caractère, et que le type (identifiant ou texte) est celui qu’on t’a donné. '}
            Les plateformes d’échange s’en servent pour savoir à qui créditer les fonds.
          </span>
        </span>
      ) : empty ? (
        <span className="text-[12px] leading-[1.45] text-mute">Aucun mémo. Si tu envoies vers une plateforme d’échange ou un service, il t’a sûrement donné un mémo : sans lui, les fonds peuvent être perdus.</span>
      ) : (
        <span className="text-[12px] text-mute">Le mémo est public et permanent ; la fenêtre système l’affiche encadré.</span>
      )}
      {dest && !dest.exists && (
        <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-warn">
          <IconInfo size={13} className="mt-0.5 shrink-0" />
          <span>Ce compte n’existe pas encore sur Stellar : envoie au moins 1 XLM pour le créer (2 × la réserve de base de 0,5 XLM, qui reste bloquée chez lui).</span>
        </span>
      )}
    </div>
  );
}

/** Spendable = balance − reserve, with the reserve explained. */
export function StellarSpendable({ account, hidden }: { account: StellarAccountInfo | undefined; hidden: boolean }) {
  if (!account) return null;
  if (!account.exists) {
    return <span className="text-[12px] text-warn">Ton compte Stellar n’est pas encore créé : il doit d’abord recevoir au moins 1 XLM.</span>;
  }
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      <strong className="font-semibold text-text2">Solde dépensable : {hidden ? '•••••' : XLM(account.spendable)}</strong> (solde {hidden ? '•••••' : XLM(account.balance)} − réserve {XLM(account.reserve)}). <StellarReserveText account={account} />
    </span>
  );
}

/** The minimum balance in plain words: (2 + entries) × base reserve (+ offers). */
export function StellarReserveText({ account }: { account: StellarAccountInfo }) {
  const entries = 2 + account.subentryCount + account.numSponsoring - account.numSponsored;
  return (
    <>
      La réserve ({entries} × {XLM(account.baseReserve)} : 2 pour le compte, 1 par ligne de confiance, offre ou signataire, ici {account.subentryCount}
      {BigInt(account.sellingLiabilities) > 0n ? `, plus ${XLM(account.sellingLiabilities)} engagés dans tes offres` : ''}) reste bloquée tant que le compte existe.
    </>
  );
}

const memoShown = (u: StellarUnsigned): { value: string; kind: string } | null => {
  const m = u.summary.memo;
  switch (m.kind) {
    case 'none':
      return null;
    case 'text':
      return { value: m.text ?? m.hex, kind: m.text === null ? 'octets' : 'texte' };
    case 'id':
      return { value: m.id, kind: 'identifiant' };
    case 'hash':
      return { value: m.hex, kind: 'hash' };
    case 'return':
      return { value: m.hex, kind: 'remboursement' };
  }
};

/** Rust's decoding, before the password: memo framed, account creation, fee, reserve, validity. */
export function StellarSummaryView({ u, xlmPrice, currency }: { u: StellarUnsigned; xlmPrice: number | null; currency: Currency }) {
  const s = u.summary;
  const c = u.context;
  const memo = memoShown(u);
  const fiat = (st: string) => {
    const v = xlmPrice !== null ? (Number(BigInt(st)) / 1e7) * xlmPrice : 0;
    return v >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  const minutes = Math.max(0, Math.ceil((s.maxTime - c.ledgerTime) / 60));
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label="Transaction Stellar décodée">
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">{u.createsAccount ? 'Création de compte Stellar' : 'Paiement Stellar'}</span>
        <span className="text-[11px] text-mute">décodé par le coffre</span>
      </div>
      <div className={cn('mx-3 my-2.5 rounded-ctl border-2 px-3 py-2 text-center', memo ? 'border-ice-line' : c.destination.memoRequired ? 'border-down/60' : 'border-warn/50')}>
        <span className="block text-[12px] font-medium text-mute">Mémo{memo ? ` (${memo.kind})` : ''}</span>
        <span className={cn('block font-mono font-semibold break-all', memo ? 'text-text' : 'text-warn', memo && memo.value.length > 24 ? 'text-[12px]' : 'text-[18px]')}>{memo ? memo.value : 'AUCUN'}</span>
      </div>
      {u.createsAccount && <Line k="Compte destinataire" v="créé par cet envoi (CreateAccount : 1 XLM de réserve bloqué chez lui)" warn />}
      <Line k="Frais max." v={`${XLM(s.fee)}${fiat(s.fee)} (d’habitude ${c.baseFee} stroops prélevés)`} />
      <Line k="Ton solde" v={XLM(c.account.balance)} />
      <Line k="Réserve bloquée" v={`${XLM(c.account.reserve)} ((2 + ${c.account.subentryCount}) × ${XLM(c.baseReserve)})`} />
      <Line k="Dépensable" v={XLM(c.account.spendable)} />
      <Line k="Valable" v={`≈ ${minutes} min (limite de temps signée), séquence ${s.sequence}`} />
      <Line k="Réseau signé" v={s.network === 'mainnet' ? 'Public Global Stellar Network' : 'Test SDF Network'} last />
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

type Status = { state: 'pending' } | { state: 'included' } | { state: 'failed' } | { state: 'error'; message: string };

/**
 * After `stellar_broadcast` (Horizon answers once the transaction is in a ledger): confirms it
 * with `stellar_tx_status`.
 */
export function StellarTxStatusLine({ adapter, hash, recipient, onIncluded }: { adapter: StellarAdapter; hash: string; recipient: string; onIncluded?: () => void }) {
  const [status, setStatus] = useState<Status>({ state: 'pending' });
  useEffect(() => {
    let alive = true;
    let timer = 0;
    let tries = 0;
    const tick = async () => {
      try {
        const s = await adapter.txStatus(hash);
        if (!alive) return;
        if (s.found) {
          setStatus(s.successful ? { state: 'included' } : { state: 'failed' });
          if (s.successful) onIncluded?.();
          return;
        }
      } catch (e) {
        if (!alive) return;
        setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
      if (++tries < 30) timer = window.setTimeout(() => void tick(), 2_000);
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
        <Spinner /> Vérification de l’inclusion dans le registre Stellar…
      </div>
    );
  }
  if (status.state === 'included') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        <strong className="font-semibold">Incluse :</strong> la transaction est dans un registre Stellar (définitif en quelques secondes). {shortAddress(recipient)} a reçu les fonds.
      </Notice>
    );
  }
  if (status.state === 'failed') {
    return (
      <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />} className="w-full text-left">
        <strong className="font-semibold">Échouée :</strong> le réseau a refusé l’opération, rien n’a été livré. Les frais (100 stroops d’habitude) sont tout de même prélevés.
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      Suivi impossible pour l’instant : {status.message}
    </Notice>
  );
}
