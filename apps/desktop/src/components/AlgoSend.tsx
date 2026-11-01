// SPDX-License-Identifier: GPL-3.0-or-later
// Algorand pieces of the Send screen (docs/IPC.md §2.11):
// - the optional note (public for ever, ≤ 1024 bytes, reinforced confirmation in the vault);
// - what Rust will check: minimum balance (0.1 ALGO) of a new receiver, spendable = balance −
//   minimum balance, rekeyed sender refused;
// - the Rust-decoded payment before the password, and the confirmation follow-up (algo_tx_status).

import { useEffect, useState } from 'react';
import type { AlgoAccountInfo, Currency } from '@kyro/shared';
import { ALGO_MAX_NOTE, algoNoteBytes, type AlgorandAdapter, type AlgoUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice, Spinner } from './ui/primitives';
import { IconCheck, IconInfo, IconWarn } from './icons';
import { cn } from '../lib/cn';

/** 0.1 ALGO: what a new account must receive at least. */
export const ALGO_ACTIVATION = 100_000n;
const ALGO = (micro: bigint | string) => fmtCrypto(BigInt(micro), 6, 'ALGO', 6);

/** Note field + receiver facts (does it exist? its minimum balance). */
export function AlgoNoteField({ value, onChange, dest, destLoading }: { value: string; onChange: (v: string) => void; dest: AlgoAccountInfo | undefined; destLoading: boolean }) {
  const bytes = algoNoteBytes(value);
  const tooLong = bytes > ALGO_MAX_NOTE;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="algo-note" className="eyebrow">
          Note <span className="font-normal normal-case tracking-normal text-mute">· facultative, publique pour toujours</span>
        </label>
        <span className={cn('text-[11px]', tooLong ? 'text-down' : 'text-faint')}>
          {bytes} / {ALGO_MAX_NOTE} octets
        </span>
      </div>
      <input
        id="algo-note"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder="ex. référence de facture"
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={tooLong}
        className="h-11 rounded-ctl border border-line-2 bg-bg px-3 text-[13px] text-text focus:border-ice-line"
      />
      {tooLong && <span className="text-[12px] text-down">Note trop longue : 1024 octets au plus.</span>}
      {value.trim() !== '' && !tooLong && <span className="text-[12px] text-mute">Lisible par tous sur la chaîne, pour toujours : une 2ᵉ confirmation te sera demandée.</span>}
      {destLoading && (
        <span className="flex items-center gap-1.5 text-[11px] text-mute">
          <Spinner /> lecture du compte destinataire…
        </span>
      )}
      {dest && !dest.exists && (
        <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-warn">
          <IconInfo size={13} className="mt-0.5 shrink-0" />
          <span>Ce compte n’existe pas encore sur Algorand : envoie au moins {ALGO(dest.minBalance)} (solde minimum, qui reste bloqué chez lui), sinon le paiement est rejeté.</span>
        </span>
      )}
    </div>
  );
}

/** Spendable = balance − minimum balance, with the minimum explained. */
export function AlgoSpendable({ account, hidden }: { account: AlgoAccountInfo | undefined; hidden: boolean }) {
  if (!account) return null;
  if (account.authAddr) {
    return <span className="text-[12px] text-down">Ce compte a été « rekeyé » vers {shortAddress(account.authAddr)} : sa clé n’est plus celle de ton coffre, Kyro ne peut pas signer pour lui.</span>;
  }
  if (!account.exists) {
    return <span className="text-[12px] text-warn">Ton compte Algorand n’existe pas encore : il doit d’abord recevoir au moins 0,1 ALGO.</span>;
  }
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      <strong className="font-semibold text-text2">Solde dépensable : {hidden ? '•••••' : ALGO(account.spendable)}</strong> (solde {hidden ? '•••••' : ALGO(account.balance)} − solde minimum {ALGO(account.minBalance)}). Le solde minimum (0,1 ALGO + 0,1 ALGO par token ASA activé, ici {account.assets}) reste toujours sur ton compte.
    </span>
  );
}

/** Rust's decoding, before the password: receiver, note, fee, network, validity window. */
export function AlgoSummaryView({ u, algoPrice, currency }: { u: AlgoUnsigned; algoPrice: number | null; currency: Currency }) {
  const s = u.summary;
  const c = u.context;
  const fiat = (d: string) => {
    const v = algoPrice !== null ? (Number(BigInt(d)) / 1e6) * algoPrice : 0;
    return v >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label="Paiement Algorand décodé">
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">Paiement Algorand</span>
        <span className="text-[11px] text-mute">décodé par le coffre</span>
      </div>
      {!c.destination.exists && <Line k="Compte destinataire" v={`créé par ce paiement (${ALGO(c.destination.minBalance)} restent bloqués chez lui)`} warn />}
      {s.noteLen > 0 && <Line k="Note (publique)" v={s.noteText !== null ? `« ${s.noteText} »` : `${s.noteLen} octets binaires`} warn />}
      <Line k="Frais" v={`${ALGO(s.fee)}${fiat(s.fee)}`} />
      <Line k="Ton solde" v={ALGO(c.account.balance)} />
      <Line k="Solde minimum bloqué" v={ALGO(c.account.minBalance)} />
      <Line k="Dépensable" v={ALGO(c.account.spendable)} />
      <Line k="Réseau" v={s.genesisId} />
      <Line k="Valable" v={`rounds ${s.firstValid} à ${s.lastValid}`} />
      <Line k="Identifiant" v={shortAddress(s.txid)} last />
    </div>
  );
}

function Line({ k, v, warn, last }: { k: string; v: string; warn?: boolean; last?: boolean }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-3.5 py-1.5', !last && 'border-b border-line')}>
      <span className="text-text2">{k}</span>
      <span className={cn('text-right break-all', warn ? 'text-warn' : 'text-text2')}>{v}</span>
    </div>
  );
}

type Status = { state: 'pending' } | { state: 'confirmed'; round: number | null } | { state: 'dropped'; error: string } | { state: 'expired' } | { state: 'error'; message: string };

/**
 * After `algo_broadcast`: follows `algo_tx_status` until the payment is in a block (≈ 3 s,
 * final immediately on Algorand). A pool error means it was dropped (never confirmed); after the
 * validity window (≈ 9 min) it can no longer be included.
 */
export function AlgoTxStatusLine({ adapter, txid, recipient, onConfirmed }: { adapter: AlgorandAdapter; txid: string; recipient: string; onConfirmed?: () => void }) {
  const [status, setStatus] = useState<Status>({ state: 'pending' });
  useEffect(() => {
    let alive = true;
    const started = Date.now();
    let timer = 0;
    const tick = async () => {
      try {
        const s = await adapter.txStatus(txid);
        if (!alive) return;
        if (s.confirmed) {
          setStatus({ state: 'confirmed', round: s.round });
          onConfirmed?.();
          return;
        }
        if (s.error) {
          setStatus({ state: 'dropped', error: s.error });
          return;
        }
        if (Date.now() - started > 600_000) {
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
  }, [adapter, txid]);

  if (status.state === 'pending') {
    return (
      <div role="status" className="flex w-full items-center gap-2 rounded-ctl border border-line bg-raised px-3.5 py-2.5 text-[13px] text-text2">
        <Spinner /> En attente d’un bloc Algorand (quelques secondes)…
      </div>
    );
  }
  if (status.state === 'confirmed') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        <strong className="font-semibold">Confirmée{status.round !== null ? ` au round ${status.round}` : ''} :</strong> sur Algorand, un bloc est définitif. {shortAddress(recipient)} a reçu les fonds.
      </Notice>
    );
  }
  if (status.state === 'dropped') {
    return (
      <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />} className="w-full text-left">
        <strong className="font-semibold">Rejetée par le réseau :</strong> {status.error}. Rien n’a été prélevé.
      </Notice>
    );
  }
  if (status.state === 'expired') {
    return (
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
        Toujours pas confirmée après 10 minutes : sa fenêtre de validité est dépassée, elle ne sera plus incluse. Vérifie l’historique avant de renvoyer.
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      Suivi de la confirmation impossible pour l’instant : {status.message}
    </Notice>
  );
}
