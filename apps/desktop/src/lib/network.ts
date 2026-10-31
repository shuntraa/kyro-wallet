// SPDX-License-Identifier: GPL-3.0-or-later
//
// Network choice (docs/IPC.md §2.10): labels and the confirmation text. Public data only.

import type { Network, NetworkInfo } from '@kyro/shared';

export const NETWORK_LABEL: Record<Network, string> = {
  mainnet: 'Réseau principal',
  testnet: 'Réseau de test',
};

export const NETWORK_HINT: Record<Network, string> = {
  mainnet: 'fonds réels',
  testnet: 'jetons sans valeur',
};

/** Text of the confirmation dialog (pure, tested). */
export function networkSwitchText(info: Pick<NetworkInfo, 'network' | 'otherVaultExists'>, target: Network, hasVault = true): string[] {
  const from = NETWORK_LABEL[info.network].toLowerCase();
  const to = NETWORK_LABEL[target].toLowerCase();
  return [
    hasVault
      ? `Chaque réseau a son propre coffre. Ton coffre du ${from} est gardé sur cet ordinateur, rien n’est supprimé : tu le retrouves en revenant sur ce réseau.`
      : 'Chaque réseau a son propre coffre : changer de réseau ne supprime rien.',
    info.otherVaultExists ? `Un coffre existe déjà sur le ${to} : Kyro le rouvrira (avec son propre mot de passe).` : `Aucun coffre sur le ${to} pour l’instant : tu pourras en créer un ou importer une phrase de récupération.`,
    target === 'mainnet' ? 'Sur le réseau principal, les montants sont de vrais fonds : chaque envoi est définitif.' : 'Sur le réseau de test, les jetons n’ont aucune valeur : ne t’en sers pas pour recevoir de vrais fonds.',
    'Kyro se verrouille puis redémarre.',
  ];
}
