// SPDX-License-Identifier: GPL-3.0-or-later
// The offer to get a chain's coin when a fee cannot be paid (components/MissingFee.tsx).

export const topup = {
  'topup.short': '{symbol} insuffisant pour les frais de réseau : il manque environ {missing}.',
  'topup.from': 'Depuis {source} sur {chain}, environ {fiat}',
  'topup.change': 'Changer',
  'topup.changeLabel': 'Payer avec',
  'topup.get': 'Obtenir des {symbol}',
  'topup.checking': 'Vérification de la route…',
  'topup.noQuoteSource': 'Pas de devis depuis cette source pour le moment. Choisis-en une autre.',
  'topup.noSource': 'Rien de ce que tu détiens sur un autre réseau ne peut être échangé contre des {symbol}. Envoies-en sur ton adresse {chain} :',
  'topup.openReceive': 'Ouvrir Recevoir',
  'topup.backToSend': 'Revenir à ton envoi',
  'topup.back': 'Revenir',
  'topup.waiting': 'Tes {symbol} sont en route. Cela peut prendre quelques minutes.',
  'topup.arrived': 'Tes {symbol} sont arrivés.',
} as const;
