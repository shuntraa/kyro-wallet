// SPDX-License-Identifier: GPL-3.0-or-later
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { App } from './App';
import { torStore } from './state/tor';
import { cbfStore } from './state/cbf';
import { hwPromptStore } from './state/hw';
import { navigatorLang } from '@kyro/shared';
import { setSystemLanguage } from './i18n';

const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.closest('input, textarea, [contenteditable="true"]') !== null);

document.addEventListener('contextmenu', (e) => {
  if (!isField(e.target)) e.preventDefault();
});
document.addEventListener('dragstart', (e) => {
  if (!isField(e.target)) e.preventDefault();
});

// Language until Rust answers (config_get.systemLanguage, settings.language): the WebView's.
setSystemLanguage(navigatorLang());

// Tor state: subscribed once for the whole app lifetime (status bar, dialogs, screens).
void torStore.start();
void cbfStore.start();
void hwPromptStore.start();

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
