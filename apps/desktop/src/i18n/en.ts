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
import { settings } from './en/settings';
import { servers } from './en/servers';
import { hw } from './en/hw';
import { stellar } from './en/stellar';

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
  ...settings,
  ...servers,
  ...hw,
  ...stellar,
};

export const enAreas = { common, shell, welcome, portfolio, history, send, receive, swap, staking, settings, servers, hw, stellar } as const;
