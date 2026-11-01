// SPDX-License-Identifier: GPL-3.0-or-later
// Sui pieces of the Send screen (components/SuiSend.tsx).

import type { sui as fr } from '../fr/sui';

export const sui: Record<keyof typeof fr, string> = {
  'sui.spendable': '<b>Spendable balance: {spendable}</b>',
  'sui.addressBalance': ' · {amount} are in Sui’s “address balance”, which Kyro cannot spend yet.',
  'sui.gasOnTop': 'The gas fee comes on top of the amount.',
  'sui.decodedLabel': 'Decoded Sui transfer',
  'sui.title': 'Sui transfer',
  'sui.decodedByVault': 'decoded by the vault',
  'sui.lToken': 'Token',
  'sui.lAmount': 'Amount',
  'sui.allCoins': 'the whole coin balance{receives}',
  'sui.receives': ' (≈ {amount} received)',
  'sui.lFeeSim': 'Estimated fee (simulation)',
  'sui.lGasBudget': 'Max. gas budget',
  'sui.lGasPrice': 'Gas price',
  'sui.lGasPriceValue': '{price} MIST/unit (reference {reference})',
  'sui.lGasCoins': 'Gas coins',
  'sui.otherCoins': '· {count} other coins',
  'sui.lValidEpoch': 'Valid until epoch',
  'sui.lValidEpochValue': '#{epoch} (current {current})',
  'sui.noLimit': 'no limit',
  'sui.lDigest': 'Digest',
  'sui.unknown': 'unknown',
  'sui.pending': 'Transaction final on Sui, waiting for the indexer (a few seconds)…',
  'sui.done': '<b>Executed:</b> the transfer is included in a Sui checkpoint. {recipient} received the funds.',
  'sui.failed': '<b>Failed:</b> {error}. Nothing was transferred; the gas fee is still charged.',
  'sui.slow': 'The indexer does not show it yet after 1 minute. The transaction was final when sent: check the history before sending again.',
  'sui.trackError': 'Tracking unavailable for now: {message}',
  'sui.lTokenValue': '{symbol} · {decimals} decimals (Kyro’s table)',
  'sui.lCoinType': 'Verified coin type',
  'sui.lTokenCoins': '{symbol} coins merged',
  'sui.allToken': 'the whole {symbol} balance ({amount})',
  'sui.gasInSui': 'Gas is paid in SUI: keep a few thousandths of a SUI on this account.',
};
