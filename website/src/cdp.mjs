// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal Chrome DevTools Protocol client for headless Microsoft Edge. Node 22+, no dependencies.
// Used by capture.mjs (app screenshots) and preview.mjs (site previews).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts headless Edge and returns { send, close } bound to its first page. */
export async function launch({ port = 9333 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kyro-edge-'));
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    await sleep(200);
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
    } catch {}
  }
  if (!page) throw new Error('Edge did not start (is EDGE set correctly?)');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, (d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const close = async () => {
    ws.close();
    proc.kill();
    await sleep(500);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  await send('Page.enable');
  return { send, evaluate, close };
}

export const viewport = (b, width, height, scale = 2, mobile = false) =>
  b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });

export async function goto(b, url, settle = 1500) {
  await b.send('Page.navigate', { url });
  await sleep(settle);
}

export async function screenshot(b, { full = false, clip } = {}) {
  const r = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  return Buffer.from(r.data, 'base64');
}
