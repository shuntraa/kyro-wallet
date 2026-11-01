// SPDX-License-Identifier: GPL-3.0-or-later
// French catalog (the original wording). One file per area in ./fr; keys are prefixed by the area.

import { common } from './fr/common';
import { shell } from './fr/shell';
import { welcome } from './fr/welcome';
import { portfolio } from './fr/portfolio';
import { history } from './fr/history';
import { send } from './fr/send';
import { receive } from './fr/receive';
import { swap } from './fr/swap';
import { staking } from './fr/staking';
import { settings } from './fr/settings';
import { servers } from './fr/servers';
import { hw } from './fr/hw';
import { stellar } from './fr/stellar';
import { near } from './fr/near';
import { algo } from './fr/algo';
import { hbar } from './fr/hbar';
import { dot } from './fr/dot';
import { xmr } from './fr/xmr';
import { ton } from './fr/ton';
import { cosmos } from './fr/cosmos';
import { aptos } from './fr/aptos';
import { sui } from './fr/sui';
import { kas } from './fr/kas';
import { update } from './fr/update';
import { multinet } from './fr/multinet';

export const fr = {
  ...common,
  ...shell,
  ...welcome,
  ...portfolio,
  ...history,
  ...send,
  ...receive,
  ...swap,
  ...staking,
  ...settings,
  ...servers,
  ...hw,
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
} as const;

/** Area modules, for the catalog tests (keys must start with `<area>.`). */
export const frAreas = { common, shell, welcome, portfolio, history, send, receive, swap, staking, settings, servers, hw, stellar, near, algo, hbar, dot, xmr, ton, cosmos, aptos, sui, kas, update, multinet } as const;
