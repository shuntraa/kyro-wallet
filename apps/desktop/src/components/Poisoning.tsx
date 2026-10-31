// SPDX-License-Identifier: GPL-3.0-or-later
// Address-poisoning alert (SECURITY.md): the recipient shares the first and last characters of
// an address the user knows, without being it. Blocking until explicitly acknowledged.

import { lookalikeSegments, type Family, type KnownAddress, type Lookalike } from '@kyro/chains';
import { IconInfo, IconWarn } from './icons';

const SOURCE: Record<KnownAddress['source'], string> = { contact: 'carnet d’adresses', own: 'ton propre compte', sent: 'déjà payée depuis ce Kyro', history: 'ton historique' };

const nameOf = (k: KnownAddress) => (k.label ? `${k.label} (${SOURCE[k.source]})` : SOURCE[k.source]);

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
  const { known, recipientKnown } = lookalike;
  const knownName = nameOf(known);
  return (
    <div role="alert" className="dialog flex flex-col gap-2.5 rounded-box border border-l-[3px] border-down/60 border-l-down bg-down/[.08] px-4 py-3.5 text-[13px] leading-[1.5] text-[#ffc2c2]" data-state="open">
      <span className="flex items-start gap-2">
        <IconWarn size={16} className="mt-0.5 shrink-0 text-down" />
        {recipientKnown ? (
          <span>
            <strong className="font-semibold">
              Cette adresse ({nameOf(recipientKnown)}) ressemble à {known.address.slice(0, 10)}…{known.address.slice(-6)} sans être identique.
            </strong>{' '}
            Deux adresses de ta liste ont le même début et la même fin : l’une des deux est peut-être un sosie, enregistré ou payé par erreur. Vérifie l’adresse entière auprès de ton destinataire avant d’envoyer.
          </span>
        ) : (
          <span>
            <strong className="font-semibold">
              Cette adresse ressemble à {known.address.slice(0, 10)}…{known.address.slice(-6)} sans être identique : c’est la technique d’empoisonnement d’adresse.
            </strong>{' '}
            Quelqu’un a pu glisser dans ton historique une adresse fabriquée pour ressembler à celle de {knownName}, par un transfert minuscule ou nul, en espérant que tu la copies.
          </span>
        )}
      </span>
      <div className="flex flex-col gap-1.5 rounded-ctl border border-down/20 bg-bg/70 px-3 py-2.5">
        <span className="text-[12px] font-medium text-mute">Tu vas envoyer à</span>
        <Highlighted address={recipient} family={family} />
        <span className="pt-1 text-[12px] font-medium text-mute">Adresse connue ({knownName})</span>
        <Highlighted address={known.address} family={family} />
        <span className="text-[11px] text-mute">Le début et la fin sont identiques ; le milieu (surligné) diffère.</span>
      </div>
      <label className="flex cursor-pointer items-center gap-2 font-semibold text-text">
        <input type="checkbox" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} className="size-4" />
        J’ai vérifié, c’est bien la bonne adresse
      </label>
    </div>
  );
}

export function DustOnlyNote() {
  return (
    <div role="status" className="fade-in flex items-start gap-2 rounded-ctl border border-l-2 border-warn/35 border-l-warn bg-warn/[.06] px-3.5 py-2.5 text-[12px] leading-[1.5] text-[#f7d9a4]">
      <IconInfo size={14} className="mt-0.5 shrink-0 text-warn" />
      <span>Cette adresse n’apparaît dans ton historique que par des transferts nuls, minuscules ou que tu n’as pas signés (même affichés « envoyés »). C’est ainsi que les escrocs glissent une adresse dans ton historique : vérifie-la auprès de ton destinataire, pas depuis l’historique.</span>
    </div>
  );
}
