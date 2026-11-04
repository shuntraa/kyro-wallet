// SPDX-License-Identifier: GPL-3.0-or-later
// Address-poisoning alert (SECURITY.md): the recipient shares the first and last characters of an
// address the user knows, without being it.

import { lookalikeSegments, type Family, type KnownAddress, type Lookalike } from '@kyro/chains';
import { IconInfo, IconWarn } from './icons';
import { HIDDEN } from './kit';
import { t, useT } from '../i18n';
import { rt } from '../i18n/rich';

const SOURCE: Record<KnownAddress['source'], 'send.poisonSourceContact' | 'send.poisonSourceOwn' | 'send.poisonSourceSent' | 'send.poisonSourceHistory'> = { contact: 'send.poisonSourceContact', own: 'send.poisonSourceOwn', sent: 'send.poisonSourceSent', history: 'send.poisonSourceHistory' };

const nameOf = (k: KnownAddress) => (k.label ? t('send.poisonNamed', { label: k.label, source: t(SOURCE[k.source]) }) : t(SOURCE[k.source]));

const strong = { b: (c: React.ReactNode) => <strong className="font-semibold">{c}</strong> };

function Highlighted({ address, family }: { address: string; family: Family }) {
  const s = lookalikeSegments(address, family);
  return (
    <span className="font-mono text-[12px] break-all">
      <span className="text-text2">{s.prefix}</span>
      <span className="font-semibold text-text">{s.head}</span>
      <mark className="rounded-[3px] bg-down/30 px-0.5 text-[#ffd0d0]">{s.middle}</mark>
      <span className="font-semibold text-text">{s.tail}</span>
    </span>
  );
}

export function PoisoningWarning({ recipient, lookalike, family, acknowledged, onAcknowledge }: { recipient: string; lookalike: Lookalike; family: Family; acknowledged: boolean; onAcknowledge: (v: boolean) => void }) {
  const { t } = useT();
  const { known, recipientKnown } = lookalike;
  const knownName = nameOf(known);
  const knownShort = `${known.address.slice(0, 10)}…${known.address.slice(-6)}`;
  return (
    <div role="alert" className="dialog flex flex-col gap-2.5 rounded-box border border-l-[3px] border-down/60 border-l-down bg-down/[.08] px-4 py-3.5 text-[13px] leading-[1.5] text-[#ffc2c2]" data-state="open">
      <span className="flex items-start gap-2">
        <IconWarn size={16} className="mt-0.5 shrink-0 text-down" />
        {recipientKnown ? (
          <span>{rt('send.poisonBothKnown', strong, { name: nameOf(recipientKnown), known: knownShort })}</span>
        ) : (
          <span>{rt('send.poisonLookalike', strong, { known: knownShort, name: knownName })}</span>
        )}
      </span>
      <div className="flex flex-col gap-1.5 rounded-ctl border border-down/20 bg-bg/70 px-3 py-2.5">
        <span className="text-[12px] font-medium text-mute">{t('send.poisonYouSendTo')}</span>
        <Highlighted address={recipient} family={family} />
        <span className="pt-1 text-[12px] font-medium text-mute">{t('send.poisonKnownAddress', { name: knownName })}</span>
        <Highlighted address={known.address} family={family} />
        <span className="text-[12px] text-mute">{t('send.poisonSameEnds')}</span>
      </div>
      <label className="flex cursor-pointer items-center gap-2 font-semibold text-text">
        <input type="checkbox" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} className="size-4" />
        {t('send.poisonAck')}
      </label>
    </div>
  );
}

export function DustOnlyNote() {
  const { t } = useT();
  return (
    <div role="status" className="fade-in flex items-start gap-2 rounded-ctl border border-l-2 border-warn/35 border-l-warn bg-warn/[.06] px-3.5 py-2.5 text-[12px] leading-[1.5] text-[#f7d9a4]">
      <IconInfo size={14} className="mt-0.5 shrink-0 text-warn" />
      <span>{t('send.poisonDustOnly')}</span>
    </div>
  );
}

/** Dust protection: tiny coins from strangers, in the balance but left out of sends. */
export function SetAsideNote({ amount, hidden, include, onInclude }: { amount: string; hidden: boolean; include: boolean; onInclude: (v: boolean) => void }) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-1 rounded-ctl border border-line-2 px-3 py-2.5 text-[12.5px] leading-[1.5] text-mute">
      <span>
        <span className="font-semibold text-text">{t('send.setAside', { amount: hidden ? HIDDEN : amount })}</span> {t('send.setAsideWhy')}
      </span>
      <label className="flex cursor-pointer items-center gap-2 font-medium text-text2">
        <input type="checkbox" checked={include} onChange={(e) => onInclude(e.target.checked)} />
        {t('send.setAsideInclude')}
      </label>
    </div>
  );
}
