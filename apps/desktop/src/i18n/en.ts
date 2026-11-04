// SPDX-License-Identifier: GPL-3.0-or-later
// English catalog: same keys as fr.ts (checked by the compiler and by catalog.test.ts).

import type { fr } from './fr';
import { common } from './en/common';
import { shell } from './en/shell';
import { welcome } from './en/welcome';
import { portfolio } from './en/portfolio';
import { history } from './en/history';
import { send } from './en/send';
import { receive } from './en/receive';
import { swap } from './en/swap';
import { staking } from './en/staking';
import { earn } from './en/earn';
import { settings } from './en/settings';
import { servers } from './en/servers';
import { hw } from './en/hw';
import { watch } from './en/watch';
import { wallets } from './en/wallets';
import { sim } from './en/sim';
import { stellar } from './en/stellar';
import { near } from './en/near';
import { algo } from './en/algo';
import { hbar } from './en/hbar';
import { dot } from './en/dot';
import { xmr } from './en/xmr';
import { ton } from './en/ton';
import { cosmos } from './en/cosmos';
import { aptos } from './en/aptos';
import { sui } from './en/sui';
import { kas } from './en/kas';
import { update } from './en/update';
import { multinet } from './en/multinet';

export const en: Record<keyof typeof fr, string> = {
  ...common,
  ...shell,
  ...welcome,
  ...portfolio,
  ...history,
  ...send,
  ...receive,
  ...swap,
  ...staking,
  ...earn,
  ...settings,
  ...servers,
  ...hw,
  ...watch,
  ...wallets,
  ...sim,
  ...stellar,
  ...near,
  ...algo,
  ...hbar,
  ...dot,
  ...xmr,
  ...ton,
  ...cosmos,
  ...aptos,
  ...sui,
  ...kas,
  ...update,
  ...multinet,
};

export const enAreas = { common, shell, welcome, portfolio, history, send, receive, swap, staking, earn, settings, servers, hw, watch, wallets, sim, stellar, near, algo, hbar, dot, xmr, ton, cosmos, aptos, sui, kas, update, multinet } as const;
