// SPDX-License-Identifier: GPL-3.0-or-later
// Rust-decoded Solana summary (sol_decode_tx), shown before the password.

import type { Currency, SolInstruction, SolTxSummary, SolWarning } from '@kyro/shared';
import type { AssetDef, SolUnsigned } from '@kyro/chains';
import { fmtCrypto, fmtFiat, shortAddress } from '../lib/format';
import { t, tp, useT } from '../i18n';
import { Notice } from './ui/primitives';
import { IconWarn } from './icons';

export function solWarningText(w: SolWarning, s: SolTxSummary): string {
  const ix = (i: number) => {
    const ins = s.instructions[i];
    return ins ? t('send.solIxLabeled', { n: i + 1, label: instructionLabel(ins) }) : t('send.solIx', { n: i + 1 });
  };
  switch (w.kind) {
    case 'feePayerNotUs':
      return t('send.solFeePayerNotUs', { addr: shortAddress(w.feePayer) });
    case 'extraWritableSigner':
      return t('send.solExtraSigner', { addr: shortAddress(w.address) });
    case 'authorityNotUs':
      return t('send.solAuthorityNotUs', { ix: ix(w.instruction), addr: shortAddress(w.authority) });
    case 'delegation':
      return t('send.solDelegation', { ix: ix(w.instruction) });
    case 'unknownInstruction':
      return t('send.solUnknownInstruction', { program: shortAddress(w.programId), ix: ix(w.instruction) });
    case 'token2022ExtensionsUnverified':
      return t('send.solToken2022', { ix: ix(w.instruction) });
    case 'priorityFeeEstimated':
      return t('send.solPriorityEstimated');
    case 'unknownOwnerProgram':
      return t('send.solUnknownOwner', { owner: shortAddress(w.owner), ix: ix(w.instruction) });
    case 'uncheckedTokenTransfer':
      return t('send.solUncheckedTransfer', { ix: ix(w.instruction) });
    case 'unusualText':
      return t('send.solUnusualText', { ix: ix(w.instruction) });
  }
}

export function instructionLabel(i: SolInstruction): string {
  switch (i.type) {
    case 'systemTransfer':
      return t('send.solLabelTransfer');
    case 'tokenTransfer':
      return i.checked ? 'TransferChecked' : 'Transfer';
    case 'tokenApprove':
      return 'Approve';
    case 'ataCreate':
      return t('send.solLabelAtaCreate');
    case 'computeUnitLimit':
      return t('send.solLabelComputeLimit');
    case 'computeUnitPrice':
      return 'priority fee';
    case 'memo':
      return t('send.solLabelMemo');
    case 'systemCreateAccountWithSeed':
      return t('send.solLabelCreateWithSeed');
    case 'stakeInitialize':
      return t('send.solLabelStakeInit');
    case 'stakeDelegate':
      return t('send.solLabelStakeDelegate');
    case 'stakeDeactivate':
      return t('send.solLabelStakeDeactivate');
    case 'stakeWithdraw':
      return t('send.solLabelStakeWithdraw');
    case 'unknown':
      return t('send.solLabelUnknown');
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
  const { t } = useT();
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
          <span className="font-semibold">{t('send.solExtraConfirm')}</span>
          <ul className="m-0 mt-1 list-disc pl-4">
            {s.warnings.map((w, i) => (
              <li key={i}>{solWarningText(w, s)}</li>
            ))}
          </ul>
        </Notice>
      )}
      <dl className="m-0 flex flex-col text-[13px]">
        <Row
          k={t('send.recipient')}
          v={<span className="font-mono text-[12px]">{shortAddress(transfer?.type === 'tokenTransfer' ? (create?.type === 'ataCreate' ? create.owner : unsigned.recipient) : sysTransfer?.type === 'systemTransfer' ? sysTransfer.to : unsigned.recipient)}</span>}
        />
        {transfer?.type === 'tokenTransfer' && (
          <>
            <Row k={t('send.solTokenAccount')} v={<span className="font-mono text-[12px]">{shortAddress(transfer.destination)}</span>} />
            <Row
              k={t('common.amount')}
              v={
                <>
                  {fmtCrypto(BigInt(transfer.amount), transfer.decimals ?? asset.decimals, asset.symbol)}{' '}
                  <span className="font-mono text-[11px] text-mute">mint {shortAddress(transfer.mint ?? '?')}</span>
                </>
              }
            />
            <Row k={t('send.solProgram')} v={transfer.tokenProgram === 'token2022' ? 'Token-2022' : 'SPL Token'} />
          </>
        )}
        {sysTransfer?.type === 'systemTransfer' && <Row k={t('common.amount')} v={fmtCrypto(BigInt(sysTransfer.lamports), 9, 'SOL')} />}
        {create?.type === 'ataCreate' && (
          <Row
            k={t('send.solAccountCreation')}
            v={
              <span className="text-warn">
                {fmtCrypto(unsigned.ataRent, 9, sol.symbol, 9)}
                {fiat(unsigned.ataRent)} · {t('send.solRentDeposit')}
              </span>
            }
          />
        )}
        <Row k={t('send.solBaseFee')} v={`${fmtCrypto(base, 9, 'SOL', 9)}${fiat(base)}`} />
        <Row k="Priority fee" v={priority > 0n ? `${fmtCrypto(priority, 9, 'SOL', 9)}${fiat(priority)} · ${s.computeUnitPriceMicroLamports ?? '0'} µL × ${s.computeUnitLimit ?? '?'} CU` : t('send.solNone')} />
        {memos.map((m, i) => (
          <Row key={i} k={t('send.solMemo')} v={<span className="text-text2">{t('common.quoted', { text: m.text })}</span>} />
        ))}
        <Row k={t('send.solVersion')} v={`${s.version}${s.lookupTables.length ? ` · ${tp('send.solTables', s.lookupTables.length)}` : ''} · ${t('send.solSignature', { n: (s.ourSignerIndex ?? -1) + 1, total: s.signers.length })}`} />
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
