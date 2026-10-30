// SPDX-License-Identifier: GPL-3.0-or-later
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Fonts bundled locally (OFL): no request to Google Fonts (CSP).
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { App } from './App';
import { torStore } from './state/tor';
import { cbfStore } from './state/cbf';
import { hwPromptStore } from './state/hw';

const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.closest('input, textarea, [contenteditable="true"]') !== null);

// Desktop-app behaviour: no context menu outside fields, no dragging images/icons.
document.addEventListener('contextmenu', (e) => {
  if (!isField(e.target)) e.preventDefault();
});
document.addEventListener('dragstart', (e) => {
  if (!isField(e.target)) e.preventDefault();
});

// Tor state: subscribed once for the whole app lifetime (status bar, dialogs, screens).
void torStore.start();
// Compact filters: availability (FEATURE_DISABLED in today's build) and `cbf-status` events.
void cbfStore.start();
// Hardware wallets: `hw-prompt` (confirm / PIN on the device, Trezor One PIN matrix).
void hwPromptStore.start();

const root = document.getElementById('root');
if (!root) throw new Error('#root introuvable');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
