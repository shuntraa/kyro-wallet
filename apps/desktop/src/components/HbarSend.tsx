// SPDX-License-Identifier: GPL-3.0-or-later
// Hedera pieces of the Send / Receive screens (docs/IPC.md §2.11):
// - the memo field, ALWAYS visible right under the recipient (exchanges identify deposits by it);
// - what Rust will check: our account exists (created by the first HBAR received), the
//   recipient exists / is not deleted / does not require its own signature; an EVM address
//   without account is auto-created (higher max fee);
// - the Rust-decoded transfer before the password, and the consensus follow-up (hbar_tx_status).

import { useEffect, useState } from 'react';
import type { Currency, HbarOwnAccount, HbarRecipientInfo } from '@kyro/shared';
import { hbarMemoError, type HbarAdapter, type HbarUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice, Spinner } from './ui/primitives';
import { IconCheck, IconInfo, IconWarn } from './icons';
import { cn } from '../lib/cn';

const HBAR = (t: bigint | string) => fmtCrypto(BigInt(t), 8, 'HBAR', 8);

export const EXCHANGE_MEMO_HINT = 'Les plateformes d’échange exigent presque toujours un mémo pour un dépôt HBAR : sans lui, les fonds peuvent être perdus.';

export function HbarMemoField({ value, onChange, dest, destLoading }: { value: string; onChange: (v: string) => void; dest: HbarRecipientInfo | undefined; destLoading: boolean }) {
  const error = hbarMemoError(value);
  const bytes = new TextEncoder().encode(value).length;
  return (
    <div className={cn('flex flex-col gap-2 rounded-box border px-4 py-3.5', error ? 'border-down/60 bg-down/[.05]' : 'border-ice-line bg-ice/[.05]')}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="hbar-memo" className="text-[13px] font-semibold text-text">
          Mémo <span className="font-normal text-mute">· facultatif, public</span>
        </label>
        {destLoading ? (
          <span className="flex items-center gap-1.5 text-[11px] text-mute">
            <Spinner /> lecture du compte…
          </span>
        ) : (
          <span className={cn('text-[11px]', bytes > 100 ? 'text-down' : 'text-faint')}>{bytes} / 100 octets</span>
        )}
      </div>
      <input
        id="hbar-memo"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder="ex. 104857 (mémo de dépôt de ta plateforme)"
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        className="h-11 rounded-ctl border border-line-3 bg-bg px-3 font-mono text-[15px] font-semibold text-text focus:border-ice-line"
      />
      {error && <span className="text-[12px] text-down">{error}</span>}
      {value === '' ? (
        <span className="text-[12px] leading-[1.45] text-mute">Aucun mémo. {EXCHANGE_MEMO_HINT}</span>
      ) : (
        <span className="text-[12px] text-mute">Le mémo est public et permanent ; la fenêtre système l’affiche encadré. Vérifie-le chiffre par chiffre.</span>
      )}
      {dest && !dest.exists && dest.isEvm && (
        <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-warn">
          <IconInfo size={13} className="mt-0.5 shrink-0" />
          <span>Cette adresse EVM n’a pas encore de compte Hedera : ton transfert le crée (frais de création ≈ 0,05 $, payés par toi).</span>
        </span>
      )}
      {dest && dest.isEvm && dest.exists && dest.accountId && <span className="text-[12px] text-mute">Compte de cette adresse selon le nœud miroir : {dest.accountId}</span>}
    </div>
  );
}

/** Problems with the recipient that Rust refuses anyway (shown before building). */
export function hbarRecipientProblem(dest: HbarRecipientInfo | undefined): string | null {
  if (!dest) return null;
  if (dest.deleted) return 'Ce compte Hedera est supprimé : le transfert échouerait.';
  if (dest.receiverSigRequired) return 'Ce compte exige sa propre signature pour recevoir : un transfert simple échouerait.';
  if (!dest.isEvm && !dest.exists) return 'Ce compte Hedera n’existe pas (identifiant inconnu du nœud miroir).';
  return null;
}

/** Our account: not created yet, or found by public key (then only `0.0.x` may be used). */
export function HbarAccountState({ account, hidden }: { account: HbarOwnAccount | undefined; hidden: boolean }) {
  if (!account) return null;
  if (!account.exists) {
    return <span className="text-[12px] text-warn">Ton compte Hedera n’existe pas encore : il est créé par le premier HBAR reçu sur ton adresse EVM (Recevoir).</span>;
  }
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      <strong className="font-semibold text-text2">Compte {account.accountId}</strong> · solde {hidden ? '•••••' : HBAR(account.balance)}
      {account.hollow ? ' · pas encore de clé : ton premier envoi la fixe (compte créé par un transfert reçu).' : ''}
    </span>
  );
}

/** Rust's decoding, before the password: memo framed, account creation, max fee, validity. */
export function HbarSummaryView({ u, hbarPrice, currency }: { u: HbarUnsigned; hbarPrice: number | null; currency: Currency }) {
  const s = u.summary;
  const c = u.context;
  const fiat = (t: string) => {
    const v = hbarPrice !== null ? (Number(BigInt(t)) / 1e8) * hbarPrice : 0;
    return v >= 0.01 ? ` · ${fmtFiat(v, currency)}` : '';
  };
  return (
    <div className="flex flex-col gap-0 rounded-box border border-line text-[12px]" aria-label="Transfert Hedera décodé">
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="font-semibold text-text">Transfert Hedera (CryptoTransfer)</span>
        <span className="text-[11px] text-mute">décodé par le coffre</span>
      </div>
      <div className={cn('mx-3 my-2.5 rounded-ctl border-2 px-3 py-2 text-center', s.memo !== null ? 'border-ice-line' : 'border-warn/50')}>
        <span className="block text-[12px] font-medium text-mute">Mémo</span>
        <span className={cn('block break-all font-mono text-[16px] font-semibold', s.memo !== null ? 'text-text' : 'text-warn')}>{s.memo !== null ? `« ${s.memo} »` : 'AUCUN'}</span>
      </div>
      <Line k="Depuis" v={s.from} />
      <Line k="Vers" v={s.toIsEvm ? `${s.to} (adresse EVM)` : s.to} />
      {c.createsAccount && <Line k="Compte destinataire" v="créé par ce transfert (≈ 0,05 $ de frais)" warn />}
      <Line k="Frais maximum" v={`${HBAR(s.maxFee)}${fiat(s.maxFee)} · seuls les frais réels sont prélevés`} />
      <Line k="Ton solde" v={HBAR(c.account.balance)} />
      <Line k="Identifiant" v={s.transactionId} />
      <Line k="Validité" v={`${s.validDuration} s · signée pour ${s.nodes.join(', ')}`} last />
    </div>
  );
}

function Line({ k, v, warn, last }: { k: string; v: string; warn?: boolean; last?: boolean }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-3.5 py-1.5', !last && 'border-b border-line')}>
      <span className="text-text2">{k}</span>
      <span className={cn('break-all text-right', warn ? 'text-warn' : 'text-text2')}>{v}</span>
    </div>
  );
}

type Status = { state: 'pending' } | { state: 'done' } | { state: 'failed'; result: string } | { state: 'expired' } | { state: 'error'; message: string };

/** After `hbar_broadcast`: follows `hbar_tx_status` until the mirror node has the transaction. */
export function HbarTxStatusLine({ adapter, id, recipient, onDone }: { adapter: HbarAdapter; id: string; recipient: string; onDone?: () => void }) {
  const [status, setStatus] = useState<Status>({ state: 'pending' });
  useEffect(() => {
    let alive = true;
    const started = Date.now();
    let timer = 0;
    const tick = async () => {
      try {
        const s = await adapter.txStatus(id);
        if (!alive) return;
        if (s.found) {
          if (s.result === 'SUCCESS') {
            setStatus({ state: 'done' });
            onDone?.();
          } else setStatus({ state: 'failed', result: s.result || 'inconnu' });
          return;
        }
        if (Date.now() - started > 240_000) {
          setStatus({ state: 'expired' });
          return;
        }
      } catch (e) {
        if (!alive) return;
        setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
      timer = window.setTimeout(() => void tick(), 3_000);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [adapter, id]);

  if (status.state === 'pending') {
    return (
      <div role="status" className="flex w-full items-center gap-2 rounded-ctl border border-line bg-raised px-3.5 py-2.5 text-[13px] text-text2">
        <Spinner /> En attente du consensus Hedera (quelques secondes)…
      </div>
    );
  }
  if (status.state === 'done') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        <strong className="font-semibold">Confirmé :</strong> le transfert a atteint le consensus (SUCCESS). {shortAddress(recipient)} a reçu les fonds.
      </Notice>
    );
  }
  if (status.state === 'failed') {
    return (
      <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />} className="w-full text-left">
        <strong className="font-semibold">Échoué ({status.result}) :</strong> le réseau a refusé le transfert, rien n’a été livré. Les frais réels sont tout de même prélevés.
      </Notice>
    );
  }
  if (status.state === 'expired') {
    return (
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
        Toujours pas visible après 4 minutes : la fenêtre de validité (180 s) est passée, il ne sera plus exécuté. Vérifie l’historique avant de renvoyer.
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      Suivi impossible pour l’instant : {status.message}
    </Notice>
  );
}
