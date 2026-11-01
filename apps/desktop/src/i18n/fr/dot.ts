// SPDX-License-Identifier: GPL-3.0-or-later
// Polkadot pieces of the Send screen (components/PolkadotSend.tsx).

export const dot = {
  'dot.spendable': 'Disponible : {spendable} sur {free}{frozen}. Le dépôt existentiel ({ed}) reste toujours sur ton compte : Kyro envoie avec transfer_keep_alive, qui ne peut pas le vider.',
  'dot.frozen': ' (dont {frozen} bloqués : staking, vesting ou vote)',
  'dot.destMissing': 'Ce compte n’existe pas encore : envoie-lui au moins le dépôt existentiel ({ed}), sinon le transfert échoue.',
  'dot.to': 'Vers {to} sur {chain}',
  'dot.fee': 'Frais estimés par le nœud : ≈ {fee}{fiat} · pourboire {tip}',
  'dot.validity': 'Valable jusqu’au bloc n° {until} ({era} blocs) · nonce {nonce} · runtime {spec} / {tx}',
  'dot.createsAccount': 'Ce transfert crée le compte du destinataire (au moins {ed}).',
  'dot.pending': 'En attente de finalisation (en général moins d’une minute)…',
  'dot.finalized': '<b>Incluse et finalisée :</b> la transaction de nonce {nonce} est dans un bloc finalisé. Kyro ne lit pas les événements de la chaîne : vérifie le solde du destinataire si besoin.',
  'dot.expired': '<b>Expirée :</b> la transaction n’a pas été incluse avant le bloc n° {until}. Elle ne le sera plus jamais ; rien n’a été débité. Tu peux renvoyer.',
  'dot.trackError': 'Suivi indisponible : {message}',
} as const;
