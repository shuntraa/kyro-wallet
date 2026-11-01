// SPDX-License-Identifier: GPL-3.0-or-later
// Reinforced confirmation (docs/IPC.md §1): when Rust's Bitcoin or EVM summary says
// `requiresExtraConfirmation`, the verification panel lists why, and warns that the system window
// will ask a second time.

import type { BtcWarning, EvmWarning } from '@kyro/shared';
import { fmtCrypto, shortAddress } from '../lib/format';
import { t, useT } from '../i18n';
import { IconWarn } from './icons';

export function btcWarningText(w: BtcWarning): string {
  switch (w.kind) {
    case 'unknownScript':
      return t('send.btcUnknownScript', { n: w.output + 1 });
    case 'opReturn':
      return t('send.btcOpReturn', { n: w.output + 1 });
    case 'foreignInput':
      return t('send.btcForeignInput', { n: w.input + 1 });
    case 'highFee':
      return t('send.btcHighFee', { rate: w.satPerVb });
    case 'changeIndexOutOfRange':
      return t('send.btcChangeIndex', { n: w.output + 1 });
  }
}

/** `native`: symbol + decimals of the chain's coin, for amounts in wei. */
export function evmWarningText(w: EvmWarning, native: { symbol: string; decimals: number }, token?: { symbol: string; decimals: number }): string {
  switch (w.kind) {
    case 'contractCall':
      return t('send.evmContractCall');
    case 'approval':
      return t('send.evmApproval', {
        spender: shortAddress(w.spender),
        amount: w.unlimited ? t('send.evmUnlimited') : token ? fmtCrypto(BigInt(w.amount || '0'), token.decimals, token.symbol) : t('send.evmUnits', { amount: w.amount }),
      });
    case 'valueToContract':
      return t('send.evmValueToContract', { amount: fmtCrypto(BigInt(w.valueWei), native.decimals, native.symbol) });
    case 'unknownChain':
      return t('send.evmUnknownChain', { id: w.chainId });
    case 'highFee':
      return t('send.evmHighFee', { amount: fmtCrypto(BigInt(w.maxFeeWei), native.decimals, native.symbol) });
  }
}

export function SecondConfirmNotice({ lines }: { lines: string[] }) {
  const { t } = useT();
  if (lines.length === 0) return null;
  return (
    <div role="status" className="fade-in flex flex-col gap-1.5 rounded-box border border-l-2 border-warn/40 border-l-warn bg-warn/[.07] px-4 py-3 text-[12px] leading-[1.5] text-[#f7d9a4]">
      <span className="flex items-center gap-1.5 text-[13px] font-semibold">
        <IconWarn size={14} className="shrink-0 text-warn" /> {t('send.secondTitle')}
      </span>
      <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <span className="font-semibold text-text">{t('send.secondLine')}</span>
    </div>
  );
}
