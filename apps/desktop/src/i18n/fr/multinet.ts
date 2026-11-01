// SPDX-License-Identifier: GPL-3.0-or-later
// Network choice in Envoyer for an asset held on several chains (components/NetworkPicker.tsx).

export const multinet = {
  'multinet.network': 'Réseau',
  'multinet.pickNetwork': 'Envoyer des {symbol} depuis le réseau',
  'multinet.networkAria': 'Réseau de {symbol} : {chain}. Changer de réseau',
  'multinet.onNetwork': '{symbol} sur {chain}',
  'multinet.networksCount': 'disponible sur {n} réseaux',
  'multinet.sameNetwork': 'Le destinataire doit recevoir des {symbol} sur {chain}. Envoyés sur un autre réseau, ils peuvent être perdus : vérifie le réseau demandé par l’exchange ou la personne.',
  'multinet.wrongNetwork': 'Cette adresse est une adresse {networks}, pas {chain}. Choisis ce réseau ci-dessus si le destinataire attend des {symbol} là-bas, sinon vérifie l’adresse.',
  'multinet.groupHint': '{amount} au total · {n} réseaux',
} as const;
