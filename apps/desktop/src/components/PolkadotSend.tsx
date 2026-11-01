// SPDX-License-Identifier: GPL-3.0-or-later
// Polkadot pieces of the Send screen (docs/IPC.md §2.11):
// - what Rust will check: a new account needs at least the existential deposit, spendable =
//   free − max(frozen − reserved, existential deposit) (transfer_keep_alive keeps ours alive);
// - the Rust-decoded transfer before the password, and the follow-up by nonce (dot_tx_status).

import { useEffect, useState } from 'react';
import type { Currency, DotAccountInfo } from '@kyro/shared';
import type { DotUnsigned, PolkadotAdapter } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice, Spinner } from './ui/primitives';
import { IconCheck, IconInfo, IconWarn } from './icons';

/** What can be sent (fee included), and why it is less than the balance. */
export function DotSpendable({ account, decimals, symbol, hidden }: { account: DotAccountInfo | undefined; decimals: number; symbol: string; hidden: boolean }) {
  if (!account) return null;
  const f = (v: string) => (hidden ? '•••••' : fmtCrypto(BigInt(v), decimals, symbol));
  return (
    <span className="text-[12px] leading-[1.45] text-mute">
      Disponible : {f(account.spendable)} sur {f(account.free)}
      {BigInt(account.frozen) > 0n ? ` (dont ${f(account.frozen)} bloqués : staking, vesting ou vote)` : ''}. Le dépôt existentiel ({fmtCrypto(BigInt(account.existentialDeposit), decimals, symbol)}) reste toujours sur ton compte : Kyro envoie avec transfer_keep_alive, qui ne peut pas le vider.
    </span>
  );
}

/** Recipient facts, under the address field. */
export function DotDestinationNote({ dest, decimals, symbol }: { dest: DotAccountInfo | undefined; decimals: number; symbol: string }) {
  if (!dest || dest.exists) return null;
  return (
    <span className="flex items-start gap-1.5 text-[12px] leading-[1.45] text-warn">
      <IconInfo size={13} className="mt-0.5 shrink-0" />
      <span>Ce compte n’existe pas encore : envoie-lui au moins le dépôt existentiel ({fmtCrypto(BigInt(dest.existentialDeposit), decimals, symbol)}), sinon le transfert échoue.</span>
    </span>
  );
}

/** Rust's decoding of the transfer, before the password. */
export function DotSummaryView({ u, price, currency }: { u: DotUnsigned; price: number | null; currency: Currency }) {
  const s = u.summary;
  const c = u.context;
  const f = (v: string) => fmtCrypto(BigInt(v), s.decimals, s.symbol);
  const fee = BigInt(c.fee);
  const feeFiat = price !== null ? (Number(fee) / 10 ** s.decimals) * price : null;
  return (
    <div className="flex flex-col gap-1.5 rounded-box border border-line bg-bg px-3.5 py-3 text-[12px] leading-[1.45] text-text2">
      <span className="font-semibold text-text">{s.call}</span>
      <span>
        Vers <span className="font-mono">{shortAddress(s.to)}</span> sur {s.chain}
      </span>
      <span>
        Frais estimés par le nœud : ≈ {f(c.fee)}
        {feeFiat !== null ? ` · ${fmtFiat(feeFiat, currency)}` : ''} · pourboire {f(s.tip)}
      </span>
      <span>
        Valable jusqu’au bloc n° {c.validUntil} ({s.eraPeriod} blocs) · nonce {s.nonce} · runtime {s.specVersion} / {s.txVersion}
      </span>
      {!c.destination.exists && <span className="text-warn">Ce transfert crée le compte du destinataire (au moins {f(c.existentialDeposit)}).</span>}
    </div>
  );
}

type Status = { state: 'pending' } | { state: 'finalized' } | { state: 'expired' } | { state: 'error'; message: string };

/** Follow-up of a broadcast transfer by its nonce (finalized state of the node). */
export function DotTxStatusLine({ adapter, nonce, validUntil, onFinalized }: { adapter: PolkadotAdapter; nonce: number; validUntil: number; onFinalized?: () => void }) {
  const [status, setStatus] = useState<Status>({ state: 'pending' });
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const tick = async () => {
      try {
        const s = await adapter.txStatus(nonce, validUntil);
        if (!alive) return;
        if (s.state === 'finalized') {
          setStatus({ state: 'finalized' });
          onFinalized?.();
          return;
        }
        if (s.state === 'expired') {
          setStatus({ state: 'expired' });
          return;
        }
      } catch (e) {
        if (!alive) return;
        setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
      timer = window.setTimeout(() => void tick(), 4_000);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [adapter, nonce, validUntil]);

  if (status.state === 'pending') {
    return (
      <div role="status" className="flex w-full items-center gap-2 rounded-ctl border border-line bg-raised px-3.5 py-2.5 text-[13px] text-text2">
        <Spinner /> En attente de finalisation (en général moins d’une minute)…
      </div>
    );
  }
  if (status.state === 'finalized') {
    return (
      <Notice tone="success" icon={<IconCheck size={16} className="mt-0.5 shrink-0 text-up" />} className="w-full text-left">
        <strong className="font-semibold">Incluse et finalisée :</strong> la transaction de nonce {nonce} est dans un bloc finalisé. Kyro ne lit pas les événements de la chaîne : vérifie le solde du destinataire si besoin.
      </Notice>
    );
  }
  if (status.state === 'expired') {
    return (
      <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
        <strong className="font-semibold">Expirée :</strong> la transaction n’a pas été incluse avant le bloc n° {validUntil}. Elle ne le sera plus jamais ; rien n’a été débité. Tu peux renvoyer.
      </Notice>
    );
  }
  return (
    <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />} className="w-full text-left">
      Suivi indisponible : {status.message}
    </Notice>
  );
}
