// SPDX-License-Identifier: GPL-3.0-or-later
// « Kyro updated to X »: shown once, after a start that applied an automatic update.
import { useEffect, useState } from 'react';
import { call } from '@kyro/shared';
import { useT } from '../i18n';
import { IconX } from './icons';

const SHOWN_MS = 10_000;

export function UpdateNotice() {
  const { t } = useT();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    call('update_status')
      .then((s) => {
        if (alive && s.updatedTo) setVersion(s.updatedTo);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!version) return;
    const id = window.setTimeout(() => setVersion(null), SHOWN_MS);
    return () => window.clearTimeout(id);
  }, [version]);

  if (!version) return null;
  return (
    <div role="status" className="fade-in fixed right-5 bottom-12 z-50 flex items-center gap-3 rounded-box border border-up/25 border-l-2 border-l-up bg-card px-4 py-3 text-[13px] text-text2 shadow-lg">
      <span>{t('update.updated')}</span>
      <button type="button" aria-label={t('update.dismiss')} onClick={() => setVersion(null)} className="text-mute hover:text-text">
        <IconX size={14} />
      </button>
    </div>
  );
}
