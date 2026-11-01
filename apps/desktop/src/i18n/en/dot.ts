// SPDX-License-Identifier: GPL-3.0-or-later
// Polkadot pieces of the Send screen (components/PolkadotSend.tsx).

import type { dot as fr } from '../fr/dot';

export const dot: Record<keyof typeof fr, string> = {
  'dot.spendable': 'Available: {spendable} of {free}{frozen}. The existential deposit ({ed}) always stays on your account: Kyro sends with transfer_keep_alive, which cannot empty it.',
  'dot.frozen': ' (including {frozen} locked: staking, vesting or vote)',
  'dot.destMissing': 'This account does not exist yet: send it at least the existential deposit ({ed}), otherwise the transfer fails.',
  'dot.to': 'To {to} on {chain}',
  'dot.fee': 'Fee estimated by the node: ≈ {fee}{fiat} · tip {tip}',
  'dot.validity': 'Valid until block #{until} ({era} blocks) · nonce {nonce} · runtime {spec} / {tx}',
  'dot.createsAccount': 'This transfer creates the recipient’s account (at least {ed}).',
  'dot.pending': 'Waiting for finalization (usually less than a minute)…',
  'dot.finalized': '<b>Included and finalized:</b> the transaction with nonce {nonce} is in a finalized block. Kyro does not read the chain’s events: check the recipient’s balance if needed.',
  'dot.expired': '<b>Expired:</b> the transaction was not included before block #{until}. It never will be; nothing was debited. You can send again.',
  'dot.trackError': 'Tracking unavailable: {message}',
  'dot.token': 'Token: {symbol} · asset ID {id} (verified, Kyro’s table) · {decimals} decimals',
  'dot.tokenAmount': 'Amount: {amount} · fee in DOT',
  'dot.tokenNewHolder': 'The recipient does not hold this token yet: this transfer creates it (at least {min}).',
  'dot.tokenSpendable': 'Sendable: {spendable} ({min} always stays on the account, “keep-alive” send) · fees are paid in DOT.',
};
