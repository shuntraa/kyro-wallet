// SPDX-License-Identifier: GPL-3.0-or-later
// The offer to get a chain's coin when a fee cannot be paid (components/MissingFee.tsx).

import type { topup as fr } from '../fr/topup';

export const topup: Record<keyof typeof fr, string> = {
  'topup.short': 'Not enough {symbol} for the network fee: about {missing} is missing.',
  'topup.from': 'From {source} on {chain}, about {fiat}',
  'topup.change': 'Change',
  'topup.changeLabel': 'Pay with',
  'topup.get': 'Get {symbol}',
  'topup.checking': 'Checking the route…',
  'topup.noQuoteSource': 'No quote from that source right now. Pick another one.',
  'topup.noSource': 'Nothing you hold on another network can be swapped for {symbol}. Send some to your {chain} address:',
  'topup.openReceive': 'Open Receive',
  'topup.backToSend': 'Back to your send',
  'topup.back': 'Go back',
  'topup.waiting': '{symbol} is on its way. This can take a few minutes.',
  'topup.arrived': '{symbol} has arrived.',
};
