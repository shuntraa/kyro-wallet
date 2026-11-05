// SPDX-License-Identifier: GPL-3.0-or-later
// Tidy small balances (screens/Tidy.tsx).

import type { tidy as fr } from '../fr/tidy';

export const tidy: Record<keyof typeof fr, string> = {
  'tidy.title': 'Tidy small balances',
  'tidy.intro': 'Convert small balances into one asset. Each swap is reviewed and signed on its own.',
  'tidy.hw': 'Swaps sign through the vault only. Switch to a vault account to tidy your balances.',
  'tidy.threshold': 'Balances under ({currency})',
  'tidy.target': 'Convert to',
  'tidy.refresh': 'Refresh quotes',
  'tidy.empty': 'No balance under this amount can be converted.',
  'tidy.tick': 'Convert {symbol} on {chain}',
  'tidy.noRoute': 'Not convertible: no route to {symbol}.',
  'tidy.noQuote': 'Not convertible: no quote right now.',
  'tidy.noFees': 'Not enough {symbol} on {chain} for the fee.',
  'tidy.feesUnknown': 'Fees unknown, so not ticked.',
  'tidy.feesHigh': 'Fees take {pct} of the value, so not ticked.',
  'tidy.feesNet': 'Fees {fees} ({pct}) · Net {net}',
  'tidy.toSign_one': '{count} swap to sign',
  'tidy.toSign_other': '{count} swaps to sign',
  'tidy.netTotal': 'net ≈ {net}',
  'tidy.nothingSelected': 'Nothing ticked.',
  'tidy.start': 'Start',
  'tidy.step': 'Swap {n} of {total}',
  'tidy.skip': 'Skip',
  'tidy.stop': 'Stop here',
  'tidy.lastDone': 'Last swap sent.',
  'tidy.lastFailed': 'Last swap failed: {reason}',
  'tidy.lastSkipped': 'Last swap skipped.',
  'tidy.summaryTitle': 'Converted to {symbol}',
  'tidy.sumDone': 'Sent: {n}',
  'tidy.sumFailed': 'Failed: {n}',
  'tidy.sumSkipped': 'Skipped: {n}',
  'tidy.sumNote': 'Swaps between networks can take a few minutes to arrive.',
  'tidy.backAssets': 'Back to Assets',
  'tidy.history': 'View history',
};
