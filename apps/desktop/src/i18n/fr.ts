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
} as const;

/** Area modules, for the catalog tests (keys must start with `<area>.`). */
export const frAreas = { common, shell, welcome, portfolio, history, send, receive, swap, staking, settings, servers, hw } as const;
