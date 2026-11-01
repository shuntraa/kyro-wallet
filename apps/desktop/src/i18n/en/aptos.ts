// SPDX-License-Identifier: GPL-3.0-or-later
// Aptos pieces of the Send screen (components/AptosSend.tsx).

import type { aptos as fr } from '../fr/aptos';

export const aptos: Record<keyof typeof fr, string> = {
  'aptos.decodedLabel': 'Decoded Aptos transfer',
  'aptos.title': 'Aptos transfer',
  'aptos.decodedByVault': 'decoded by the vault',
  'aptos.lFunction': 'Function',
  'aptos.lDest': 'Recipient account',
  'aptos.lDestCreated': 'created by this transfer (it has not received anything yet)',
  'aptos.lFeeEstimate': 'Estimated fee',
  'aptos.lFeeEstimateValue': '{fee} ({units} units × {price} octas)',
  'aptos.lFeeMax': 'Max. fee',
  'aptos.lFeeMaxValue': '{fee} ({units} units)',
  'aptos.lBalance': 'Your balance',
  'aptos.lSeqChain': 'Sequence · chain',
  'aptos.lExpires': 'Expires in',
  'aptos.lExpiresValue': '≈ {minutes} min',
  'aptos.unknown': 'unknown',
  'aptos.pending': 'Waiting for confirmation by the Aptos network (a few seconds)…',
  'aptos.committed': '<b>Confirmed:</b> the transfer is executed and final.',
  'aptos.failed': '<b>Failed ({vmStatus}):</b> nothing was transferred. The gas used is still charged.',
  'aptos.expired': 'Still not confirmed after 11 minutes: it expired and will no longer be included. Check the history before sending again.',
  'aptos.trackError': 'Confirmation tracking unavailable for now: {message}',
};
