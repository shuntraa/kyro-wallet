// SPDX-License-Identifier: GPL-3.0-or-later
// « Kyro X is installed »: one toast, after a start that applied an automatic update.
import { useEffect } from 'react';
import { call } from '@kyro/shared';
import { useT } from '../i18n';
import { notify, Toaster } from './Toast';

export function UpdateNotice() {
  const { t } = useT();
  useEffect(() => {
    let alive = true;
    call('update_status')
      .then((s) => {
        if (alive && s.updatedTo) notify({ tone: 'ok', text: t('update.updated', { version: s.updatedTo }), ms: 10_000 });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return <Toaster />;
}
