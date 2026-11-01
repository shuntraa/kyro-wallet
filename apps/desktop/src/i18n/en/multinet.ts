// SPDX-License-Identifier: GPL-3.0-or-later
import type { multinet as fr } from '../fr/multinet';

export const multinet: Record<keyof typeof fr, string> = {
  'multinet.network': 'Network',
  'multinet.pickNetwork': 'Send {symbol} from the network',
  'multinet.networkAria': '{symbol} network: {chain}. Change network',
  'multinet.onNetwork': '{symbol} on {chain}',
  'multinet.networksCount': 'available on {n} networks',
  'multinet.sameNetwork': 'The recipient must receive {symbol} on {chain}. Sent on another network, they may be lost: check the network the exchange or person asked for.',
  'multinet.wrongNetwork': 'This is a {networks} address, not {chain}. Pick that network above if the recipient expects {symbol} there, otherwise check the address.',
  'multinet.groupHint': '{amount} in total · {n} networks',
};
