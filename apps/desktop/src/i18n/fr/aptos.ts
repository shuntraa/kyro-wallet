// SPDX-License-Identifier: GPL-3.0-or-later
// Aptos pieces of the Send screen (components/AptosSend.tsx).

export const aptos = {
  'aptos.decodedLabel': 'Transfert Aptos décodé',
  'aptos.title': 'Transfert Aptos',
  'aptos.decodedByVault': 'décodé par le coffre',
  'aptos.lFunction': 'Fonction',
  'aptos.lDest': 'Compte destinataire',
  'aptos.lDestCreated': 'créé par ce transfert (il n’a encore rien reçu)',
  'aptos.lFeeEstimate': 'Frais estimés',
  'aptos.lFeeEstimateValue': '{fee} ({units} unités × {price} octas)',
  'aptos.lFeeMax': 'Frais maximum',
  'aptos.lFeeMaxValue': '{fee} ({units} unités)',
  'aptos.lBalance': 'Ton solde',
  'aptos.lSeqChain': 'Séquence · chaîne',
  'aptos.lExpires': 'Expire dans',
  'aptos.lExpiresValue': '≈ {minutes} min',
  'aptos.unknown': 'inconnu',
  'aptos.pending': 'En attente de confirmation par le réseau Aptos (quelques secondes)…',
  'aptos.committed': '<b>Confirmée :</b> le transfert est exécuté et définitif.',
  'aptos.failed': '<b>Échouée ({vmStatus}) :</b> rien n’a été transféré. Le gaz utilisé est tout de même prélevé.',
  'aptos.expired': 'Toujours pas confirmée après 11 minutes : elle a expiré et ne sera plus incluse. Vérifie l’historique avant de renvoyer.',
  'aptos.trackError': 'Suivi de la confirmation impossible pour l’instant : {message}',
} as const;
