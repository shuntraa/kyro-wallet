// SPDX-License-Identifier: GPL-3.0-or-later
// Network choice (docs/IPC.md §2.10): labels and the confirmation text.

import type { Network, NetworkInfo } from '@kyro/shared';
import { t } from '../i18n';

export const NETWORK_LABEL: Readonly<Record<Network, string>> = {
  get mainnet() {
    return t('shell.networkMainnet');
  },
  get testnet() {
    return t('shell.networkTestnet');
  },
};

export const NETWORK_HINT: Readonly<Record<Network, string>> = {
  get mainnet() {
    return t('shell.networkMainnetHint');
  },
  get testnet() {
    return t('shell.networkTestnetHint');
  },
};

/** Text of the confirmation dialog (pure, tested). */
export function networkSwitchText(info: Pick<NetworkInfo, 'network' | 'otherVaultExists'>, target: Network, hasVault = true): string[] {
  const from = NETWORK_LABEL[info.network].toLowerCase();
  const to = NETWORK_LABEL[target].toLowerCase();
  return [
    hasVault ? t('shell.switchKeepsVault', { from }) : t('shell.switchNoVault'),
    info.otherVaultExists ? t('shell.switchOtherExists', { to }) : t('shell.switchOtherNone', { to }),
    target === 'mainnet' ? t('shell.switchToMainnetNote') : t('shell.switchToTestnetNote'),
    t('shell.switchRestarts'),
  ];
}
