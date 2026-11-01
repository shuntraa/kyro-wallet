// SPDX-License-Identifier: GPL-3.0-or-later
// Captures the Kyro desktop app (demo mode, in a plain browser) for the website. 1. In
// E:\wallet\apps\desktop: pnpm dev (Vite prints http://127.0.0.1:<port>/) 2. From site-prep: node
// website/src/capture.mjs http://127.0.0.1:<port> Window 1440x900 at device scale 2. Writes
// website/src/screenshots/app-<name>.png, then, if ffmpeg is on PATH, the WebP files the site uses
// (website/public/img/win-*.webp).

import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, viewport, goto, screenshot, sleep } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'screenshots');
const IMG = resolve(HERE, '..', 'public', 'img');
const base = (process.argv[2] || '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('usage: node website/src/capture.mjs http://127.0.0.1:<port>');
  process.exit(2);
}
mkdirSync(SHOTS, { recursive: true });

const click = (b, label) =>
  b.evaluate(`(() => {
    const re = new RegExp(${JSON.stringify(label)}, 'i');
    const el = [...document.querySelectorAll('button, a, [role=button], [role=tab]')].find(
      (e) => e.offsetParent !== null && (re.test(e.textContent.trim()) || re.test(e.getAttribute('aria-label') || '')));
    if (el) el.click();
    return !!el;
  })()`);

async function unlock(b) {
  const phase = await b.evaluate(`document.querySelector('#unlock-pw') ? 'locked' : document.querySelector('nav, [role=navigation]') ? 'ready' : 'other'`);
  if (phase === 'ready') return;
  if (phase !== 'locked') {
    // Onboarding (fresh profile): import the public BIP39 test phrase, then set a demo password.
    const ok = await b.evaluate(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const btn = (re) => [...document.querySelectorAll('button')].find((x) => re.test(x.textContent.trim()));
      btn(/^Import a recovery/).click(); await wait(800);
      const dt = new DataTransfer(); dt.setData('text', '${'abandon '.repeat(11)}about');
      const first = document.querySelector('input'); first.focus();
      first.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await wait(500); btn(/^Continue$/).click(); await wait(800);
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const id of ['pw-new', 'pw-confirm']) { const i = document.getElementById(id); set.call(i, 'demo-demo-1234'); i.dispatchEvent(new Event('input', { bubbles: true })); }
      await wait(300); btn(/^Import$/).click(); await wait(3500);
      return !!document.querySelector('nav, [role=navigation]');
    })()`);
    if (!ok) throw new Error('Onboarding failed.');
    return;
  }
  let pw = process.env.KYRO_DEMO_PASSWORD;
  if (!pw) {
    const hint = await b.evaluate(`[...document.querySelectorAll('p')].map((p) => p.textContent).find((t) => /demo/i.test(t)) || ''`);
    pw = (hint.match(/[«“"']([^»”"']+)[»”"']/) || hint.match(/:\s*(\S+?)\.?$/) || [])[1];
  }
  if (!pw) throw new Error('Demo password not found: set KYRO_DEMO_PASSWORD.');
  await b.evaluate(`(() => {
    const i = document.querySelector('#unlock-pw');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(i, ${JSON.stringify(pw)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.form.requestSubmit();
  })()`);
  await sleep(2500);
}

const SCREENS = [
  ['portfolio', ['^Portfolio$'], 2500],
  ['assets', ['^Assets$'], 2000],
  ['swap', ['^Swap$'], 4000],
  ['send', ['^Portfolio$', '^Send$'], 2000],
  ['staking', ['^Staking$'], 2500],
  ['history', ['^History$'], 2000],
  ['settings', ['^Settings$'], 2000]
];

const b = await launch({ port: 9336 });
try {
  await viewport(b, 1440, 900, 2);
  await goto(b, `${base}/?network=mainnet&lang=en`, 3000);
  await unlock(b);
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  for (const [name, path, settle] of SCREENS) {
    for (const label of path) {
      if (!(await click(b, label))) console.warn(`${name}: "${label}" not found`);
      await sleep(400);
    }
    await sleep(settle);
    const file = join(SHOTS, `app-${name}.png`);
    writeFileSync(file, await screenshot(b));
    console.log('captured', file);
  }
} finally {
  await b.close();
}

// WebP for the site. Full windows at 1600 px (2160 for the hero), plus the swap crop without the
// fee breakdown (the site states the fee in words: "Swaps from 0.7%, built into the rate you see").
const webp = (src, out, vf) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', join(SHOTS, src), '-vf', vf, '-c:v', 'libwebp', '-quality', '82', join(IMG, out)]);
try {
  webp('app-portfolio.png', 'win-portfolio.webp', 'scale=2160:-2:flags=lanczos');
  webp('app-portfolio.png', 'win-portfolio-sm.webp', 'scale=1080:-2:flags=lanczos');
  webp('app-portfolio.png', 'win-statusbar.webp', 'crop=iw:ih*0.0455:0:ih*0.9545,scale=1400:-2');
  webp('app-send.png', 'win-send.webp', 'scale=1416:-2:flags=lanczos');
  webp('app-staking.png', 'win-staking.webp', 'scale=1600:-2:flags=lanczos');
  webp('app-swap.png', 'win-swap.webp', 'crop=iw*0.9167:ih*0.447:iw*0.0694:ih*0.0606,scale=1400:-2:flags=lanczos');
  console.log('WebP written to', IMG, '- check the sizes in pages.mjs (IMG / W) if the aspect ratios changed, then run build.mjs');
} catch {
  console.warn('ffmpeg not found or failed: convert the PNGs to WebP by hand.');
}
