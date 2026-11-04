// SPDX-License-Identifier: GPL-3.0-or-later
import type { sim as fr } from '../fr/sim';

export const sim: Record<keyof typeof fr, string> = {
  'sim.title': 'Simulation',
  'sim.running': 'Simulating…',
  'sim.sendReceive': 'You send {send}, you receive about {receive}.',
  'sim.sendOnly': 'You send {send}.',
  'sim.receiveOnly': 'You receive about {receive}.',
  'sim.noMoves': 'No funds seen moving.',
  'sim.checked': 'The call goes through, but this node does not show what moves.',
  'sim.unavailable': 'Simulation not available on this node: rely on the review.',
  'sim.fails': 'This call would fail: {reason}',
  'sim.approval': 'Lets {spender} spend {amount}.',
  'sim.approvalUnlimited': 'Lets {spender} spend all your {symbol}, with no limit.',
  'sim.approvalAll': 'Lets {spender} move your whole {symbol} collection.',
  'sim.wUnknownContract': 'Contract unknown to Kyro.',
  'sim.wNewContract': 'Contract deployed less than 7 days ago.',
  'sim.wNotContract': 'There is no contract at this address.',
  'sim.wUnlimited': 'Unlimited approval: this contract can spend this token later without asking again.',
  'sim.wUnknownToken': 'Token not on Kyro’s list: its name may lie.',
  'sim.wNothingBack': 'You send funds and nothing comes back.',
  'sim.limits': 'Simulated by your node on the current network state: the result can change by signing time. The review decides.',
  'sim.afterApproval': 'The swap will be simulated after the approval, just before you sign it.',
  'sim.nextCall': 'The operation itself will be simulated after this approval.',
};
