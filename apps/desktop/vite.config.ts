// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import pkg from './package.json' with { type: 'json' };

const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    ...(host ? { hmr: { protocol: 'ws', host, port: 1421 } } : {}),
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Lightning stays out of the bundle unless asked for (docs/LIGHTNING.md). Its tests keep running.
    __KYRO_LIGHTNING__: JSON.stringify(process.env.KYRO_LIGHTNING === '1' || !!process.env.VITEST),
  },
  build: {
    // BigInt literals + modern syntax; WebView2 (Chromium) and WKWebView (Safari 16+).
    target: ['es2022', 'chrome111', 'safari16'],
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
