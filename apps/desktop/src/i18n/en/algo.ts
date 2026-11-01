// SPDX-License-Identifier: GPL-3.0-or-later
// Algorand pieces of the Send screen (components/AlgoSend.tsx).

import type { algo as fr } from '../fr/algo';

export const algo: Record<keyof typeof fr, string> = {
  'algo.note': 'Note',
  'algo.noteHint': '· optional, public forever',
  'algo.noteBytes': '{bytes} / {max} bytes',
  'algo.notePlaceholder': 'e.g. invoice reference',
  'algo.noteTooLong': 'Note too long: 1024 bytes at most.',
  'algo.notePublic': 'Readable by anyone on the chain, forever: you will be asked for a 2nd confirmation.',
  'algo.readingDest': 'reading the recipient account…',
  'algo.destMissing': 'This account does not exist on Algorand yet: send at least {min} (minimum balance, which stays locked on it), otherwise the payment is rejected.',
  'algo.rekeyed': 'This account was “rekeyed” to {addr}: its key is no longer your vault’s, Kyro cannot sign for it.',
  'algo.ownMissing': 'Your Algorand account does not exist yet: it must first receive at least 0.1 ALGO.',
  'algo.spendable': '<b>Spendable balance: {spendable}</b> (balance {balance} − minimum balance {min}). The minimum balance (0.1 ALGO + 0.1 ALGO per opted-in ASA token, here {assets}) always stays on your account.',
  'algo.decodedLabel': 'Decoded Algorand payment',
  'algo.title': 'Algorand payment',
  'algo.decodedByVault': 'decoded by the vault',
  'algo.lDest': 'Recipient account',
  'algo.lDestCreated': 'created by this payment ({min} stays locked on it)',
  'algo.lNote': 'Note (public)',
  'algo.noteBinary': '{len} binary bytes',
  'algo.lFee': 'Fee',
  'algo.lBalance': 'Your balance',
  'algo.lMinBalance': 'Locked minimum balance',
  'algo.lSpendable': 'Spendable',
  'algo.lNetwork': 'Network',
  'algo.lValid': 'Valid',
  'algo.lValidValue': 'rounds {first} to {last}',
  'algo.lTxid': 'Transaction ID',
  'algo.pending': 'Waiting for an Algorand block (a few seconds)…',
  'algo.confirmed': '<b>Confirmed:</b> on Algorand, a block is final. {recipient} received the funds.',
  'algo.confirmedRound': '<b>Confirmed in round {round}:</b> on Algorand, a block is final. {recipient} received the funds.',
  'algo.dropped': '<b>Rejected by the network:</b> {error}. Nothing was charged.',
  'algo.expired': 'Still not confirmed after 10 minutes: its validity window has passed, it will no longer be included. Check the history before sending again.',
  'algo.trackError': 'Confirmation tracking unavailable for now: {message}',
};
