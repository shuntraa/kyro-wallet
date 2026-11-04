// SPDX-License-Identifier: GPL-3.0-or-later
// Under the recipient field: what `name.eth` resolved to.

import { useT } from '../i18n';
import type { EnsState } from '../lib/useEnsRecipient';

export function EnsLine({ ens }: { ens: EnsState }) {
  const { t } = useT();
  if (ens.status === 'idle') return null;
  if (ens.status === 'loading') return <span className="text-[12px] text-mute">{t('send.ensLooking')}</span>;
  if (ens.status === 'ok') {
    return (
      <span className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-mute">
        <span className="font-medium text-text2">{ens.name}</span>
        <span className="font-mono break-all">{ens.address}</span>
      </span>
    );
  }
  const problem = ens.status === 'invalid' ? t('send.ensInvalid') : ens.status === 'notFound' ? t('send.ensNotFound') : ens.status === 'offchain' ? t('send.ensOffchain') : t('send.ensFailed');
  return <span className="text-[12px] text-down">{problem}</span>;
}
