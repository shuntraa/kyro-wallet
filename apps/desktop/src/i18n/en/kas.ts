// SPDX-License-Identifier: GPL-3.0-or-later
// Kaspa pieces of the Send screen (components/KaspaSend.tsx).

import type { kas as fr } from '../fr/kas';

export const kas: Record<keyof typeof fr, string> = {
  'kas.spendable_one': 'Spendable: {amount} ({count} coin on your first {scanned} receive and change addresses). Minimum 0.2 KAS per send: Kaspa’s storage mass (KIP-9) makes small outputs non-standard.',
  'kas.spendable_other': 'Spendable: {amount} ({count} coins on your first {scanned} receive and change addresses). Minimum 0.2 KAS per send: Kaspa’s storage mass (KIP-9) makes small outputs non-standard.',
  'kas.decodedLabel': 'Decoded Kaspa transaction',
  'kas.title': 'Kaspa transaction',
  'kas.decodedByVault': 'decoded by the vault',
  'kas.lChangeBack': 'Change (comes back to you)',
  'kas.lDest': 'Recipient',
  'kas.unknownScript': 'unknown script',
  'kas.lChange': 'Change',
  'kas.noChange': 'none: the small remainder goes to the fee',
  'kas.lFee': 'Fee',
  'kas.lMass': 'Mass',
  'kas.lMassValue': '{total} g (compute {compute}, storage {storage})',
  'kas.lMinFee': 'Relay minimum',
  'kas.lInputs': 'Inputs',
  'kas.lInputsValue_one': '{count} coin · {amount}',
  'kas.lInputsValue_other': '{count} coins · {amount}',
  'kas.pending': 'Waiting for acceptance by the Kaspa network (a few seconds)…',
  'kas.accepted': '<b>Accepted:</b> the transaction is included in the Kaspa chain.',
  'kas.unknown': 'Still not accepted after 2 minutes according to the indexer: check the history before sending again.',
  'kas.trackError': 'Acceptance tracking unavailable for now: {message}',
};
