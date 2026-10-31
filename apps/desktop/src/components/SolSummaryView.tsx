// SPDX-License-Identifier: GPL-3.0-or-later
// Rust-decoded Solana summary (sol_decode_tx), shown before the password.

import type { Currency, SolInstruction, SolTxSummary, SolWarning } from '@kyro/shared';
import type { AssetDef, SolUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { Notice } from './ui/primitives';
import { IconWarn } from './icons';

export function solWarningText(w: SolWarning, s: SolTxSummary): string {
  const ix = (i: number) => `instruction ${i + 1}${s.instructions[i] ? ` (${instructionLabel(s.instructions[i])})` : ''}`;
  switch (w.kind) {
    case 'feePayerNotUs':
      return `Les frais sont payés par une autre adresse (${shortAddress(w.feePayer)}).`;
    case 'extraWritableSigner':
      return `Une autre adresse doit aussi signer : ${shortAddress(w.address)}.`;
    case 'authorityNotUs':
      return `L’autorité de l’${ix(w.instruction)} n’est pas ton adresse (${shortAddress(w.authority)}).`;
    case 'delegation':
      return `L’${ix(w.instruction)} délègue un droit de dépense sur tes tokens.`;
    case 'unknownInstruction':
      return `Instruction non reconnue : programme ${shortAddress(w.programId)} (${ix(w.instruction)}).`;
    case 'token2022ExtensionsUnverified':
      return `Token-2022 : les extensions du mint (frais de transfert, hook…) ne sont pas vérifiées (${ix(w.instruction)}).`;
    case 'priorityFeeEstimated':
      return 'Pas de limite de calcul explicite : la priority fee affichée est un maximum estimé.';
    case 'unknownOwnerProgram':
      return `Le compte créé appartient à un programme inconnu (${shortAddress(w.owner)}) : il pourra dépenser ces SOL (${ix(w.instruction)}).`;
    case 'uncheckedTokenTransfer':
      return `Transfert de token sans mint ni décimales (Transfer, ${ix(w.instruction)}) : le token envoyé n’est pas vérifié.`;
    case 'unusualText':
      return `Texte inhabituel (mémo ou seed nettoyé, ou très long) dans l’${ix(w.instruction)}.`;
  }
}

export function instructionLabel(i: SolInstruction): string {
  switch (i.type) {
    case 'systemTransfer':
      return 'transfert SOL';
    case 'tokenTransfer':
      return i.checked ? 'TransferChecked' : 'Transfer';
    case 'tokenApprove':
      return 'Approve';
    case 'ataCreate':
      return 'création de compte de token';
    case 'computeUnitLimit':
      return 'limite de calcul';
    case 'computeUnitPrice':
      return 'priority fee';
    case 'memo':
      return 'mémo';
    case 'systemCreateAccountWithSeed':
      return 'création du compte de staking (adresse dérivée de la tienne)';
    case 'stakeInitialize':
      return 'initialisation du compte de staking';
    case 'stakeDelegate':
      return 'délégation à un validateur';
    case 'stakeDeactivate':
      return 'désactivation du stake';
    case 'stakeWithdraw':
      return 'retrait du compte de staking';
    case 'unknown':
      return 'inconnue';
    default:
      return i.type;
  }
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 border-b border-line py-1.5">
      <dt className="shrink-0 text-mute">{k}</dt>
      <dd className="m-0 min-w-0 text-right break-all">{v}</dd>
    </div>
  );
}

/** Decoded rows: recipient, amount + mint, ATA creation cost, fees, memo, warnings. */
export function SolSummaryView({ s, unsigned, asset, sol, solPrice, currency }: { s: SolTxSummary; unsigned: SolUnsigned; asset: AssetDef; sol: AssetDef; solPrice: number | null; currency: Currency }) {
  const fiat = (lamports: bigint) => (solPrice !== null ? ` · ${fmtFiat((Number(lamports) / 1e9) * solPrice, currency)}` : '');
  const transfer = s.instructions.find((i) => i.type === 'tokenTransfer');
  const sysTransfer = s.instructions.find((i) => i.type === 'systemTransfer');
  const create = s.instructions.find((i) => i.type === 'ataCreate');
  const memos = s.instructions.filter((i): i is Extract<SolInstruction, { type: 'memo' }> => i.type === 'memo');
  const priority = s.priorityFeeLamports ? BigInt(s.priorityFeeLamports) : 0n;
  const base = BigInt(s.baseFeeLamports);
  const otherWarnings = s.warnings.filter((w) => !s.requiresExtraConfirmation || w.kind === 'token2022ExtensionsUnverified' || w.kind === 'priorityFeeEstimated');

  return (
    <div className="flex flex-col gap-3">
      {s.requiresExtraConfirmation && (
        <Notice tone="error" icon={<IconWarn size={16} className="mt-0.5 shrink-0" />}>
          <span className="font-semibold">Confirmation supplémentaire requise.</span>
          <ul className="m-0 mt-1 list-disc pl-4">
            {s.warnings.map((w, i) => (
              <li key={i}>{solWarningText(w, s)}</li>
            ))}
          </ul>
        </Notice>
      )}
      <dl className="m-0 flex flex-col text-[13px]">
        <Row
          k="Destinataire"
          v={<span className="font-mono text-[12px]">{shortAddress(transfer?.type === 'tokenTransfer' ? (create?.type === 'ataCreate' ? create.owner : unsigned.recipient) : sysTransfer?.type === 'systemTransfer' ? sysTransfer.to : unsigned.recipient)}</span>}
        />
        {transfer?.type === 'tokenTransfer' && (
          <>
            <Row k="Compte de token" v={<span className="font-mono text-[12px]">{shortAddress(transfer.destination)}</span>} />
            <Row
              k="Montant"
              v={
                <>
                  {fmtCrypto(BigInt(transfer.amount), transfer.decimals ?? asset.decimals, asset.symbol)}{' '}
                  <span className="font-mono text-[11px] text-mute">mint {shortAddress(transfer.mint ?? '?')}</span>
                </>
              }
            />
            <Row k="Programme" v={transfer.tokenProgram === 'token2022' ? 'Token-2022' : 'SPL Token'} />
          </>
        )}
        {sysTransfer?.type === 'systemTransfer' && <Row k="Montant" v={fmtCrypto(BigInt(sysTransfer.lamports), 9, 'SOL')} />}
        {create?.type === 'ataCreate' && (
          <Row
            k="Création du compte"
            v={
              <span className="text-warn">
                {fmtCrypto(unsigned.ataRent, 9, sol.symbol, 9)}
                {fiat(unsigned.ataRent)} · dépôt de loyer
              </span>
            }
          />
        )}
        <Row k="Frais de base" v={`${fmtCrypto(base, 9, 'SOL', 9)}${fiat(base)}`} />
        <Row k="Priority fee" v={priority > 0n ? `${fmtCrypto(priority, 9, 'SOL', 9)}${fiat(priority)} · ${s.computeUnitPriceMicroLamports ?? '0'} µL × ${s.computeUnitLimit ?? '?'} CU` : 'aucune'} />
        {memos.map((m, i) => (
          <Row key={i} k="Mémo" v={<span className="text-text2">« {m.text} »</span>} />
        ))}
        <Row k="Version" v={`${s.version}${s.lookupTables.length ? ` · ${s.lookupTables.length} table(s)` : ''} · signature n° ${(s.ourSignerIndex ?? -1) + 1}/${s.signers.length}`} />
      </dl>
      {otherWarnings.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px] text-warn">
          {otherWarnings.map((w, i) => (
            <li key={i}>⚠ {solWarningText(w, s)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
