// SPDX-License-Identifier: GPL-3.0-or-later
// Cosmos Hub pieces of the Send screen (components/CosmosSend.tsx).

export const cosmos = {
  'cosmos.exchangeHint': 'Les plateformes d’échange exigent presque toujours un mémo pour un dépôt d’ATOM : sans lui, les fonds peuvent être perdus.',
  'cosmos.memo': 'Mémo',
  'cosmos.memoHint': '· facultatif, public pour toujours',
  'cosmos.memoPlaceholder': 'ex. 104857',
  'cosmos.noMemo': 'Aucun mémo. {hint}',
  'cosmos.memoCopy': 'Recopie-le exactement : la fenêtre système l’affiche encadré, tel que le coffre l’a décodé.',
  'cosmos.ownMissing': 'Ton compte Cosmos n’est pas encore connu du réseau : il doit d’abord recevoir des ATOM.',
  'cosmos.spendable': '<b>Disponible : {spendable}</b> (solde {balance}, le reste est encore en vesting).',
  'cosmos.decodedLabel': 'Transaction Cosmos décodée',
  'cosmos.decodedByVault': 'décodé par le coffre',
  'cosmos.memoNone': 'Aucun',
  'cosmos.lFee': 'Frais',
  'cosmos.lGas': 'Gas maximum',
  'cosmos.lGasValue': '{gas} (simulé par le réseau)',
  'cosmos.lChainId': 'Chain-id',
  'cosmos.lAccountSeq': 'Compte / séquence',
  'cosmos.lAccountSeqValue': 'n° {account} / {sequence}',
  'cosmos.lValidUntil': 'Valable jusqu’au bloc',
  'cosmos.lValidUntilValue': 'n° {height} (≈ {minutes} min)',
  'cosmos.pending': 'En attente d’inclusion dans un bloc Cosmos Hub (quelques secondes)…',
  'cosmos.included': '<b>Incluse :</b> la transaction est dans un bloc (code 0). {recipient} a reçu les ATOM.',
  'cosmos.failed': '<b>Échouée (code {code}) :</b> le réseau a refusé l’envoi{log}, rien n’a été livré. Les frais sont tout de même prélevés.',
  'cosmos.expired': 'Toujours pas incluse après 12 minutes : elle a dépassé son bloc limite et ne sera plus incluse. Vérifie l’historique avant de renvoyer.',
  'cosmos.trackError': 'Suivi de l’inclusion impossible pour l’instant : {message}',
} as const;
