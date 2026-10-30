// SPDX-License-Identifier: GPL-3.0-or-later
// Reinforced confirmation (docs/IPC.md §1): when Rust's Bitcoin or EVM summary says
// `requiresExtraConfirmation`, the verification panel lists why, and warns that the system window
// will ask a second time.

import type { BtcWarning, EvmWarning } from '@kyro/shared';
import { fmtCrypto, shortAddress } from '../lib/format';
import { IconWarn } from './icons';

export const SECOND_CONFIRM_LINE = 'Une deuxième confirmation te sera demandée dans la fenêtre système.';

export function btcWarningText(w: BtcWarning): string {
  switch (w.kind) {
    case 'unknownScript':
      return `Sortie ${w.output + 1} : script inconnu (pas une adresse standard).`;
    case 'opReturn':
      return `Sortie ${w.output + 1} : OP_RETURN (des données inscrites ; sa valeur est brûlée).`;
    case 'foreignInput':
      return `Entrée ${w.input + 1} : n’appartient pas à ce portefeuille (quelqu’un d’autre ajoute des fonds ou cosigne).`;
    case 'highFee':
      return `Frais très élevés : ${w.satPerVb} sat/vB (au-delà de 100 sat/vB, ou plus que le total des sorties).`;
  }
}

/** `native`: symbol + decimals of the chain's coin, for amounts in wei. */
export function evmWarningText(w: EvmWarning, native: { symbol: string; decimals: number }, token?: { symbol: string; decimals: number }): string {
  switch (w.kind) {
    case 'contractCall':
      return 'Appel de contrat : ce n’est pas un simple transfert, Kyro ne peut pas dire tout ce qu’il fait.';
    case 'approval':
      return `Autorisation : ${shortAddress(w.spender)} pourra dépenser ${w.unlimited ? 'un montant ILLIMITÉ' : token ? fmtCrypto(BigInt(w.amount || '0'), token.decimals, token.symbol) : `${w.amount} unités`} de ce token, sans nouvelle signature.`;
    case 'valueToContract':
      return `${fmtCrypto(BigInt(w.valueWei), native.decimals, native.symbol)} envoyés au contrat en plus de l’appel.`;
    case 'unknownChain':
      return `Réseau inconnu de Kyro (chainId ${w.chainId}).`;
    case 'highFee':
      return `Frais maximum élevés : ${fmtCrypto(BigInt(w.maxFeeWei), native.decimals, native.symbol)}.`;
  }
}

export function SecondConfirmNotice({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div role="status" className="flex flex-col gap-1.5 rounded-box border border-warn/40 bg-warn/[.07] px-4 py-3 text-[12px] leading-[1.5] text-[#f7d9a4]">
      <span className="flex items-center gap-1.5 text-[13px] font-semibold">
        <IconWarn size={14} className="shrink-0 text-warn" /> À vérifier avant de signer
      </span>
      <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <span className="font-semibold text-text">{SECOND_CONFIRM_LINE}</span>
    </div>
  );
}
