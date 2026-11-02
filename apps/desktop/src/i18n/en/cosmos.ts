// SPDX-License-Identifier: GPL-3.0-or-later
// Cosmos Hub pieces of the Send screen (components/CosmosSend.tsx).

import type { cosmos as fr } from '../fr/cosmos';

export const cosmos: Record<keyof typeof fr, string> = {
  'cosmos.exchangeHint': 'Exchanges almost always require a memo for an ATOM deposit: without it, the funds can be lost.',
  'cosmos.memo': 'Memo',
  'cosmos.memoHint': '· optional, public forever',
  'cosmos.memoPlaceholder': 'e.g. 104857',
  'cosmos.noMemo': 'No memo. {hint}',
  'cosmos.memoCopy': 'Copy it exactly: the system window shows it framed, as the vault decoded it.',
  'cosmos.ownMissing': 'Your Cosmos account is not known to the network yet: it must first receive ATOM.',
  'cosmos.spendable': '<b>Available: {spendable}</b> (balance {balance}, the rest is still vesting).',
  'cosmos.decodedLabel': 'Decoded Cosmos transaction',
  'cosmos.decodedByVault': 'decoded by the vault',
  'cosmos.memoNone': 'None',
  'cosmos.lFee': 'Fee',
  'cosmos.lGas': 'Max. gas',
  'cosmos.lGasValue': '{gas} (simulated by the network)',
  'cosmos.lChainId': 'Chain-id',
  'cosmos.lAccountSeq': 'Account / sequence',
  'cosmos.lAccountSeqValue': '#{account} / {sequence}',
  'cosmos.lValidUntil': 'Valid until block',
  'cosmos.lValidUntilValue': '#{height} (≈ {minutes} min)',
  'cosmos.pending': 'Waiting for inclusion in a Cosmos Hub block (a few seconds)…',
  'cosmos.included': '<b>Included:</b> the transaction is in a block (code 0). {recipient} received the ATOM.',
  'cosmos.failed': '<b>Failed (code {code}):</b> the network rejected the send{log}, nothing was delivered. The fee is still charged.',
  'cosmos.expired': 'Still not included after 12 minutes: it passed its limit block and will no longer be included. Check the history before sending again.',
  'cosmos.trackError': 'Inclusion tracking unavailable for now: {message}',
};
