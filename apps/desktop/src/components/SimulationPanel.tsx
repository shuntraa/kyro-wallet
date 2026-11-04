// SPDX-License-Identifier: GPL-3.0-or-later
// What a dry run of an EVM call saw, in plain words, before the confirmation window. It warns; a
// clean result proves nothing: the decoded review stays the source of truth.

import type { SimApproval, SimMove, SimReport, SimWarning } from '@kyro/chains';
import { fmtCrypto, shortAddress } from '../lib/format';
import { Spinner } from './ui/primitives';
import { IconWarn } from './icons';
import { useT } from '../i18n';

const moves = (list: SimMove[]) => list.map((m) => fmtCrypto(m.amount, m.asset.decimals, m.asset.symbol, 6)).join(', ');

/** Plain summary of the moves, `null` when the dry run measured none. */
export function moveLine(r: SimReport, t: ReturnType<typeof useT>['t']): string | null {
  const send = moves(r.sends);
  const receive = moves(r.receives);
  if (send && receive) return t('sim.sendReceive', { send, receive });
  if (send) return t('sim.sendOnly', { send });
  if (receive) return t('sim.receiveOnly', { receive });
  return null;
}

function ApprovalLine({ a }: { a: SimApproval }) {
  const { t } = useT();
  const spender = shortAddress(a.spender);
  if (a.all) return <>{t('sim.approvalAll', { spender, symbol: a.asset.symbol })}</>;
  if (a.unlimited) return <>{t('sim.approvalUnlimited', { spender, symbol: a.asset.symbol })}</>;
  return <>{t('sim.approval', { spender, amount: fmtCrypto(a.amount, a.asset.decimals, a.asset.symbol, 6) })}</>;
}

const WARNING_KEY: Record<Exclude<SimWarning, 'fails'>, 'sim.wUnknownContract' | 'sim.wNewContract' | 'sim.wNotContract' | 'sim.wUnlimited' | 'sim.wUnknownToken' | 'sim.wNothingBack'> = {
  'unknown-contract': 'sim.wUnknownContract',
  'new-contract': 'sim.wNewContract',
  'not-contract': 'sim.wNotContract',
  'unlimited-approval': 'sim.wUnlimited',
  'unknown-token': 'sim.wUnknownToken',
  'nothing-back': 'sim.wNothingBack',
};

export function SimulationPanel({ report, loading, note }: { report: SimReport | undefined; loading: boolean; note?: string }) {
  const { t } = useT();
  if (loading && !report) {
    return (
      <span className="flex items-center gap-2 text-[13px] text-mute">
        <Spinner /> {t('sim.running')}
      </span>
    );
  }
  if (!report) return <p className="m-0 text-[13px] text-mute">{t('sim.unavailable')}</p>;
  const line = moveLine(report, t);
  const warnings = report.warnings.filter((w): w is Exclude<SimWarning, 'fails'> => w !== 'fails');
  return (
    <div className="flex flex-col gap-1.5 rounded-box border border-line bg-bg px-4 py-3 text-[13px]" aria-label={t('sim.title')}>
      <span className="text-[12px] font-semibold text-mute">{t('sim.title')}</span>
      {report.status === 'failed' && (
        <span className="flex items-start gap-2 font-medium text-down">
          <IconWarn size={15} className="mt-0.5 shrink-0" /> {t('sim.fails', { reason: report.reason ?? '' })}
        </span>
      )}
      {report.status === 'unavailable' && <span className="text-text2">{t('sim.unavailable')}</span>}
      {report.status === 'checked' && <span className="text-text2">{t('sim.checked')}</span>}
      {report.status === 'traced' && <span className="font-medium">{line ?? t('sim.noMoves')}</span>}
      {report.approvals.map((a) => (
        <span key={`${a.asset.address}:${a.spender}`} className="text-text2">
          <ApprovalLine a={a} />
        </span>
      ))}
      {warnings.map((w) => (
        <span key={w} className="flex items-start gap-2 text-warn">
          <IconWarn size={15} className="mt-0.5 shrink-0" /> {t(WARNING_KEY[w])}
        </span>
      ))}
      {note && <span className="text-text2">{note}</span>}
      <span className="text-[12px] text-faint">{t('sim.limits')}</span>
    </div>
  );
}
