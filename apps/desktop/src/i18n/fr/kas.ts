// SPDX-License-Identifier: GPL-3.0-or-later
// Kaspa pieces of the Send screen (components/KaspaSend.tsx).

export const kas = {
  'kas.spendable_one': 'Dépensable : {amount} ({count} pièce sur tes {scanned} premières adresses de réception et de monnaie). Minimum 0,2 KAS par envoi : la masse de stockage de Kaspa (KIP-9) rend les petites sorties non standard.',
  'kas.spendable_other': 'Dépensable : {amount} ({count} pièces sur tes {scanned} premières adresses de réception et de monnaie). Minimum 0,2 KAS par envoi : la masse de stockage de Kaspa (KIP-9) rend les petites sorties non standard.',
  'kas.decodedLabel': 'Transaction Kaspa décodée',
  'kas.title': 'Transaction Kaspa',
  'kas.decodedByVault': 'décodée par le coffre',
  'kas.lChangeBack': 'Monnaie (revient chez toi)',
  'kas.lDest': 'Destinataire',
  'kas.unknownScript': 'script inconnu',
  'kas.lChange': 'Monnaie',
  'kas.noChange': 'aucune : le petit reste part en frais',
  'kas.lFee': 'Frais',
  'kas.lMass': 'Masse',
  'kas.lMassValue': '{total} g (calcul {compute}, stockage {storage})',
  'kas.lMinFee': 'Minimum de relais',
  'kas.lInputs': 'Entrées',
  'kas.lInputsValue_one': '{count} pièce · {amount}',
  'kas.lInputsValue_other': '{count} pièces · {amount}',
  'kas.pending': 'En attente d’acceptation par le réseau Kaspa (quelques secondes)…',
  'kas.accepted': '<b>Acceptée :</b> la transaction est incluse dans la chaîne Kaspa.',
  'kas.unknown': 'Toujours pas acceptée après 2 minutes selon l’indexeur : vérifie l’historique avant de renvoyer.',
  'kas.trackError': 'Suivi de l’acceptation impossible pour l’instant : {message}',
} as const;
