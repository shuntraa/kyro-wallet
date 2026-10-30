// SPDX-License-Identifier: GPL-3.0-or-later
// TRON: Rust's resource estimate (tron_build_tx → TronEstimate), shown before the password.
// TRON has no fee to choose: a transaction burns TRX for the bandwidth (bytes) that the free /
// staked bandwidth does not cover, for the energy of a TRC-20 call (simulated by Rust, capped by
// fee_limit) and for activating an account that does not exist yet. Rust re-reads all of it live
// in the native dialog; this view is the same numbers, earlier.

import type { Currency } from '@kyro/shared';
import { isKnownTronToken, tronCoverage, type TronUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice } from './ui/primitives';
import { IconWarn } from './icons';

const TRX = (sun: bigint | string) => fmtCrypto(BigInt(sun), 6, 'TRX', 6);
/** Rust's default activation: creation fee 1 TRX + 0.1 TRX of bandwidth (no staked bandwidth). */
const STANDARD_ACTIVATION = 1_100_000n;

export function TronEstimateView({ u, network, trxPrice, currency }: { u: TronUnsigned; network: 'mainnet' | 'testnet'; trxPrice: number | null; currency: Currency }) {
  const e = u.estimate;
  const isToken = !!u.token;
  const sent = isToken ? 0n : u.amount;
  const cov = tronCoverage(e, sent);
  const fiat = (sun: string | bigint) => (trxPrice !== null ? ` · ${fmtFiat((Number(BigInt(sun)) / 1e6) * trxPrice, currency)}` : '');
  const bwSource = e.stakedBandwidth >= e.bandwidthNeeded ? 'bande passante gelée' : e.freeBandwidth >= e.bandwidthNeeded ? 'bande passante gratuite' : 'TRX brûlés';
  const activation = BigInt(e.activationFee);
  const unverified = isToken && u.token && !isKnownTronToken(network, u.token.contract);

  return (
    <div className="flex flex-col gap-3" aria-label="Ressources TRON">
      <div className="flex flex-col gap-0 rounded-[14px] border border-line text-[12px]">
        <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
          <span className="text-[12px] font-semibold text-text">Ressources TRON</span>
          <span className="text-[11px] text-mute">estimées par le coffre</span>
        </div>
        <Line
          k="Bande passante"
          sub={`${e.bandwidthNeeded} octets nécessaires · disponible ${e.freeBandwidth} gratuite + ${e.stakedBandwidth} gelée`}
          v={BigInt(e.bandwidthBurn) > 0n ? `${TRX(e.bandwidthBurn)} brûlés` : activation > 0n ? 'compris dans l’activation' : `0 TRX (${bwSource})`}
        />
        {isToken && (
          <>
            <Line k="Énergie (simulée)" sub={`${e.energyNeeded.toLocaleString('fr-FR')} nécessaire · ${e.energyAvailable.toLocaleString('fr-FR')} disponible · ${e.energyFee} sun par unité`} v={`≈ ${TRX(e.energyBurn)} brûlés`} />
            <Line k="Plafond d’énergie (fee_limit)" sub="le maximum que l’énergie peut brûler si la simulation se trompe" v={`${TRX(e.feeLimit)} max.`} />
          </>
        )}
        {!e.recipientExists && (
          <Line
            k="Activation du compte"
            sub={activation === STANDARD_ACTIVATION ? 'le destinataire n’existe pas encore sur TRON : création 1 TRX + 0,1 TRX de bande passante' : 'le destinataire n’existe pas encore sur TRON : création du compte'}
            v={`${TRX(activation)} brûlés`}
            warn
          />
        )}
        <Line k="Total brûlé" sub="estimé · au maximum" v={`${TRX(e.totalBurn)} · ${TRX(e.totalBurnMax)}`} strong />
        <Line k="Ton solde TRX" v={`${TRX(e.balance)}${fiat(e.balance)}`} last />
      </div>

      {unverified && u.token && (
        <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
          <strong className="font-semibold">Token non vérifié :</strong> Kyro ne connaît que l’USDT sur TRON. Montant réel : <span className="font-mono">{u.amount.toString()}</span> unités brutes du contrat {shortAddress(u.token.contract)} ; « {u.token.symbol} » et ses {u.token.decimals} décimales viennent de l’interface, pas du coffre. La fenêtre système l’affiche ainsi.
        </Notice>
      )}

      {!cov.expected ? (
        <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />}>
          <strong className="font-semibold">Solde TRX insuffisant pour les frais brûlés :</strong>{' '}
          {isToken
            ? `envoyer un token sur TRON brûle des TRX (énergie, bande passante). Il faut environ ${TRX(e.totalBurn)}, tu as ${TRX(e.balance)} : il manque ${TRX(cov.missing)}.`
            : `il faut ${TRX(sent + BigInt(e.totalBurn))} (montant + brûlé estimé), tu as ${TRX(e.balance)} : il manque ${TRX(cov.missing)}.`}{' '}
          Envoi bloqué : le réseau le refuserait{isToken ? ', ou l’appel échouerait faute d’énergie en brûlant quand même des TRX' : ''}.
        </Notice>
      ) : !cov.worst ? (
        <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
          Ton solde couvre le brûlé estimé, mais pas le maximum ({TRX(e.totalBurnMax)}) : si l’énergie coûte plus que la simulation, la transaction peut échouer et les TRX brûlés ne sont pas rendus. Il manquerait {TRX(cov.missingWorst)} dans ce cas.
        </Notice>
      ) : null}
    </div>
  );
}

function Line({ k, sub, v, warn, strong, last }: { k: string; sub?: string; v: string; warn?: boolean; strong?: boolean; last?: boolean }) {
  return (
    <div className={`flex items-start justify-between gap-3 px-3.5 py-2 ${last ? '' : 'border-b border-line'}`}>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={strong ? 'font-semibold text-text' : 'text-text2'}>{k}</span>
        {sub && <span className="text-[11px] leading-[1.4] text-mute">{sub}</span>}
      </span>
      <span className={`shrink-0 text-right ${warn ? 'text-warn' : strong ? 'font-semibold text-text' : 'text-text2'}`}>{v}</span>
    </div>
  );
}
