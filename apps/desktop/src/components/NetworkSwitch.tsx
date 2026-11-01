// SPDX-License-Identifier: GPL-3.0-or-later
// Network choice (docs/IPC.md §2.10): réseau principal (real funds) or réseau de test (worthless
// coins).

import { useState } from 'react';
import { call, toIpcError, type Network, type NetworkInfo } from '@kyro/shared';
import { useAsync } from '../lib/useAsync';
import { NETWORK_HINT, NETWORK_LABEL, networkSwitchText } from '../lib/network';
import { Dialog } from './ui/dialog';
import { Button, Notice, Spinner } from './ui/primitives';
import { IconWarn } from './icons';
import { useT } from '../i18n';

/** `network_get`, reloadable. */
export function useNetworkInfo() {
  return useAsync(() => call('network_get'), []);
}

export function NetworkSwitchDialog({ info, target, onClose, hasVault = true }: { info: NetworkInfo; target: Network | null; onClose: () => void; hasVault?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useT();
  if (!target) return null;
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const restarting = await call('network_set', { network: target });
      if (!restarting) onClose();
    } catch (e) {
      setError(toIpcError(e).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()} title={t(target === 'mainnet' ? 'shell.switchTitleMainnet' : 'shell.switchTitleTestnet')} description={t('shell.networkDescription', { network: NETWORK_LABEL[target], hint: NETWORK_HINT[target] })} className="w-[520px]">
      <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-[13px] leading-[1.55] text-text2">
        {networkSwitchText(info, target, hasVault).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {target === 'mainnet' && (
        <Notice tone="warn" icon={<IconWarn size={16} className="mt-0.5 shrink-0 text-warn" />}>
          {t('shell.neverMixNetworks')}
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={() => void confirm()} disabled={busy}>
          {busy && <Spinner />} {t(target === 'mainnet' ? 'shell.restartOnMainnet' : 'shell.restartOnTestnet')}
        </Button>
      </div>
    </Dialog>
  );
}
