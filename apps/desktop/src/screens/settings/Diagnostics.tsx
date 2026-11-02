// SPDX-License-Identifier: GPL-3.0-or-later
// Settings › Networks: live tip height / round-trip of the main backends (was in the status bar).

import { bitcoinServerFor } from '@kyro/shared';
import { fmtNumber } from '../../lib/format';
import { useApp } from '../../state/app';
import { cbfPhaseLabel, useCbf } from '../../state/cbf';
import { useNetProbe } from '../../shell/StatusBar';
import { useT } from '../../i18n';

export function NetDiagnostics() {
  const { adapters, settings, network } = useApp();
  const { t, tp } = useT();
  const stat = useNetProbe();
  const cbf = useCbf().status;
  const cbfMode = bitcoinServerFor(settings.servers, network).kind === 'cbf';
  const ms = (v: number | null) => (v !== null ? `${v} ms` : t('shell.offline'));
  const btcValue = cbfMode
    ? !cbf
      ? t('shell.cbfCompact')
      : cbf.state === 'filters'
        ? t('shell.cbfFiltersPct', { n: Math.round(cbf.progress * 100) })
        : cbf.state === 'headers'
          ? cbf.tipHeight != null
            ? t('shell.cbfHeadersAt', { height: fmtNumber(cbf.tipHeight, 0) })
            : t('shell.cbfHeaders')
          : cbf.state === 'synced'
            ? `${tp('shell.peers', cbf.peers.length)}${stat.btcHeight !== null ? ` · ${t('shell.block', { height: fmtNumber(stat.btcHeight, 0) })}` : ''}`
            : cbfPhaseLabel(cbf)
    : stat.btcHeight !== null
      ? t('shell.block', { height: fmtNumber(stat.btcHeight, 0) })
      : t('shell.offline');
  const rows: Array<[string, string]> = [];
  if (adapters?.btc) rows.push([network === 'testnet' ? 'Bitcoin testnet' : 'Bitcoin', btcValue]);
  const evm = adapters ? [...adapters.evm.values()][0] : undefined;
  if (evm) rows.push([evm.chain.label, ms(stat.evmMs)]);
  if (adapters?.sol) rows.push([adapters.sol.chain.label, ms(stat.solMs)]);
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col rounded-panel border border-line bg-card px-[22px] py-4">
      <span className="pb-2 text-[15px] font-medium">{t('settings.diagnostics')}</span>
      {rows.map(([label, value]) => (
        <div key={label} className="flex h-10 items-center justify-between border-t border-line text-[13.5px]">
          <span className="text-text2">{label}</span>
          <span className="text-[13px] text-mute">{value}</span>
        </div>
      ))}
    </section>
  );
}
