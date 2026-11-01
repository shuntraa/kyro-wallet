// SPDX-License-Identifier: GPL-3.0-or-later
// Full-page previews of the built site in headless Edge, scrolled through first so every reveal has
// played. node website/src/preview.mjs <base-url> <out-dir> [path=name@width ...] e.g. node
// website/src/preview.mjs http://127.0.0.1:8099 ../site-preview /=home-desktop@1440
// /=home-mobile@390
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, viewport, goto, screenshot, sleep } from './cdp.mjs';

const [base, out, ...jobs] = process.argv.slice(2);
if (!base || !out) {
  console.error('usage: node website/src/preview.mjs <base-url> <out-dir> [path=name@width ...]');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const b = await launch({ port: 9334 });
try {
  for (const job of jobs.length ? jobs : ['/=home-desktop@1440', '/=home-mobile@390']) {
    const [, path, name, w] = job.match(/^(.*)=(.*)@(\d+)$/);
    const width = Number(w);
    const mobile = width < 700;
    await viewport(b, width, mobile ? 844 : 900, mobile ? 2 : 1, mobile);
    await goto(b, base + path);
    const h = await b.evaluate('document.documentElement.scrollHeight');
    for (let y = 0; y < h; y += 500) {
      await b.evaluate(`window.scrollTo(0, ${y})`);
      await sleep(90);
    }
    await b.evaluate('window.scrollTo(0, 0)');
    await sleep(1200);
    const full = await b.evaluate('document.documentElement.scrollHeight');
    const wide = await b.evaluate('document.documentElement.scrollWidth');
    if (wide > width) console.warn(`${name}: horizontal overflow, scrollWidth ${wide} > ${width}`);
    writeFileSync(join(out, `${name}.png`), await screenshot(b, { full: true, clip: { x: 0, y: 0, width, height: full } }));
    console.log(`${name}.png  ${width}x${full}`);
  }
} finally {
  await b.close();
}
