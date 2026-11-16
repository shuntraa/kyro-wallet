// SPDX-License-Identifier: GPL-3.0-or-later
import type { CSSProperties } from 'react';

/** Primary button: a sheet of ice (tinted like the mark's square), not plain white. */
export const FROST_STYLE: CSSProperties = {
  background: 'linear-gradient(180deg, #e6f3ff 0%, #c2e0fa 100%)',
  color: '#061423',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,.95), inset 0 -1px 0 rgba(53,119,180,.35), inset 0 0 0 1px rgba(255,255,255,.35), 0 10px 30px -12px rgba(124,196,255,.85)',
};
