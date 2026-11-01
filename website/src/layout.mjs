// SPDX-License-Identifier: GPL-3.0-or-later
// Shared page shell for kyrowallet.com: <head>, header, footer and small HTML helpers.

export const SITE = 'https://kyrowallet.com';
export const VERSION = '1.0.0';
export const REPO = 'https://github.com/shuntraa/kyro-wallet';
export const DL = `${REPO}/releases/latest/download/`;
export const FILES = {
  exe: 'Kyro-windows-x64-setup.exe',
  msi: 'Kyro-windows-x64.msi',
  dmg: 'Kyro-macos.dmg',
  appimage: 'Kyro-linux-x86_64.AppImage',
  deb: 'Kyro-linux-amd64.deb',
  sums: 'SHA256SUMS'
};

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** Tagged template that leaves interpolated strings untouched (they are already HTML). */
export const html = (strings, ...values) =>
  strings.reduce((out, s, i) => out + s + (i < values.length ? (Array.isArray(values[i]) ? values[i].join('') : values[i] ?? '') : ''), '');

/** File name (without .svg) of a blockchain's coin icon in img/coins/. */
export const iconOf = (c) => c.icon || c.ticker.toLowerCase();

/** The coin icon: our own SVG, decorative (the name is always written next to it). */
export const coin = (c, extra = '') => {
  const size = extra.split(' ').includes('coin-lg') ? 84 : 34;
  return `<img class="coin c-${c.slug}${extra ? ' ' + extra : ''}" src="/img/coins/${iconOf(c)}.svg" width="${size}" height="${size}" alt="">`;
};

// JSON-LD is data, not script: browsers never execute it, so `script-src 'self'` does not affect it.
const ldJson = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

export const NAV = [
  ['/features/', 'Features'],
  ['/chains/', 'Blockchains'],
  ['/security/', 'Security'],
  ['/fees/', 'Fees'],
  ['/faq/', 'FAQ']
];

export function breadcrumbs(trail) {
  const items = trail
    .map(([href, name], i) =>
      i === trail.length - 1 ? `<li><span aria-current="page">${esc(name)}</span></li>` : `<li><a href="${href}">${esc(name)}</a></li>`
    )
    .join('');
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${items}</ol></nav>`;
}

export function breadcrumbLd(trail) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(([href, name], i) => ({ '@type': 'ListItem', position: i + 1, name, item: SITE + href }))
  };
}

function header(path) {
  const link = ([href, label]) =>
    `<li><a href="${href}"${path === href || (href !== '/' && path.startsWith(href)) ? ' aria-current="page"' : ''}>${label}</a></li>`;
  return html`
  <header class="site-header">
    <div class="nav-pill">
      <a class="brand" href="/" aria-label="Kyro Wallet, home">
        <img src="/img/kyro-mark-dark.svg" width="26" height="26" alt="">
        <span class="brand-name" aria-hidden="true">kyro</span>
      </a>
      <nav class="nav" aria-label="Main navigation">
        <ul>
          ${NAV.map(link)}
          <li><a href="${REPO}">GitHub</a></li>
        </ul>
      </nav>
      <a class="btn btn-primary btn-sm header-cta" href="/download/">Download</a>
      <details class="menu">
        <summary aria-label="Menu"><span class="menu-bars"></span></summary>
        <nav class="menu-panel" aria-label="Menu">
          <ul>
            <li><a href="/"${path === '/' ? ' aria-current="page"' : ''}>Home</a></li>
            ${NAV.map(link)}
            <li><a href="/download/"${path === '/download/' ? ' aria-current="page"' : ''}>Download</a></li>
            <li><a href="${REPO}">GitHub</a></li>
          </ul>
        </nav>
      </details>
    </div>
  </header>`;
}

function footer(chains) {
  const top = chains.slice(0, 7);
  return html`
  <footer class="site-footer seam">
    <div class="wrap">
      <div class="footer-cols">
        <div class="footer-brand">
          <a class="brand" href="/" aria-label="Kyro Wallet, home">
            <img src="/img/kyro-mark-dark.svg" width="26" height="26" alt="">
            <span class="brand-name" aria-hidden="true">kyro</span>
          </a>
          <p>Free, open-source crypto wallet for Windows, macOS and Linux.</p>
        </div>
        <div>
          <h2>Product</h2>
          <ul>
            <li><a href="/features/">Features</a></li>
            <li><a href="/security/">Security</a></li>
            <li><a href="/fees/">Fees</a></li>
            <li><a href="/download/">Download</a></li>
            <li><a href="/faq/">FAQ</a></li>
          </ul>
        </div>
        <div>
          <h2>Blockchains</h2>
          <ul>
            ${top.map((c) => `<li><a href="/chains/${c.slug}/">${esc(c.name)}</a></li>`)}
            <li><a href="/chains/">All ${chains.length}</a></li>
          </ul>
        </div>
        <div>
          <h2>Project</h2>
          <ul>
            <li><a href="${REPO}">Source code</a></li>
            <li><a href="${REPO}/releases">Releases</a></li>
            <li><a href="${REPO}/blob/main/SECURITY.md">Security policy</a></li>
            <li><a href="${REPO}/blob/main/LICENSE">License</a></li>
          </ul>
        </div>
        <div>
          <h2>Help</h2>
          <ul>
            <li><a href="/download/#verify">Verify a download</a></li>
            <li><a href="/download/#first-launch">First launch</a></li>
            <li><a href="${REPO}/security">Report a vulnerability</a></li>
            <li><a href="/#support">Donate</a></li>
          </ul>
        </div>
      </div>
      <p class="footer-word" aria-hidden="true">kyro</p>
      <div class="footer-bottom">
        <span>Kyro ${VERSION} · GPL-3.0-or-later</span>
        <span>No cookies, no trackers · Fonts: Geist (<a href="/fonts/OFL-Geist.txt">OFL</a>)</span>
      </div>
    </div>
  </footer>`;
}

/**
 * Full HTML document. opts: path, title, description, body, chains (live list, for the footer), ld
 * (array of JSON-LD nodes), scripts (extra deferred scripts), noindex, preload (image path), ogType
 */
export function page(opts) {
  const { path, title, description, body, chains, ld = [], scripts = [], noindex = false, preload } = opts;
  const url = SITE + path;
  const graph = ld.length ? ldJson({ '@context': 'https://schema.org', '@graph': ld }) : '';
  const og = `${SITE}/img/og.jpg`;
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  ${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${url}">`}
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#07080a">
  <meta name="referrer" content="no-referrer">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="preload" href="/fonts/geist-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
  ${preload || ''}
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/chains.css">
  <meta property="og:site_name" content="Kyro Wallet">
  <meta property="og:type" content="${opts.ogType || 'website'}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  ${noindex ? '' : `<meta property="og:url" content="${url}">`}
  <meta property="og:image" content="${og}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Kyro Wallet: Your keys. Your crypto. The portfolio window with swap and vault windows.">
  <meta property="og:locale" content="en_US">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${og}">
  ${graph}
  <script src="/motion.js"></script>
  ${scripts.map((s) => `<script src="${s}" defer></script>`).join('\n  ')}
</head>
<body>
  <a class="skip" href="#content">Skip to content</a>
${header(path)}

  <main id="content">
${body}
  </main>
${footer(chains)}
</body>
</html>
`;
}

/** Hero for inner pages: breadcrumbs, eyebrow, the page's single h1 and a lead paragraph. */
export function pageHero({ trail, eyebrow, h1, lead, extra = '', before = '', aside = '' }) {
  return html`
    <section class="page-hero${aside ? ' page-hero-split' : ''}" aria-labelledby="page-title">
      <div class="aurora aurora-sm" aria-hidden="true"></div>
      <div class="wrap">
        ${breadcrumbs(trail)}
        <div class="ph-grid">
          <div class="ph-text">
            ${before}
            ${eyebrow ? `<p class="eyebrow" data-reveal>${eyebrow}</p>` : ''}
            <h1 id="page-title" data-reveal>${h1}</h1>
            ${lead ? `<p class="lead" data-reveal>${lead}</p>` : ''}
            ${extra}
          </div>
          ${aside}
        </div>
      </div>
    </section>`;
}

/** Primary download button. Without JavaScript it opens the download page. */
export const dlButton = (size = 'btn-xl') => html`
          <a class="btn btn-primary ${size}" href="/download/" data-dl-hero>
            <span class="os-icon" data-dl-icon aria-hidden="true"></span>
            <span data-dl-label>Download Kyro</span>
          </a>`;

export const osCards = () => html`
          <div class="os-cards">
            <a class="os-card os-row" data-os="windows" href="${DL}${FILES.exe}">
              <span class="os-icon os-windows" aria-hidden="true"></span>
              <span class="os-name">Windows</span>
              <span class="os-file">.exe installer</span>
            </a>
            <a class="os-card os-row" data-os="macos" href="${DL}${FILES.dmg}">
              <span class="os-icon os-apple" aria-hidden="true"></span>
              <span class="os-name">macOS</span>
              <span class="os-file">Apple Silicon &amp; Intel</span>
            </a>
            <a class="os-card os-row" data-os="linux" href="${DL}${FILES.appimage}">
              <span class="os-icon os-linux" aria-hidden="true"></span>
              <span class="os-name">Linux</span>
              <span class="os-file">AppImage</span>
            </a>
          </div>`;

/** One-line install commands (scripts in website/src/install.*, served from the site root). */
export const INSTALL = {
  windows: `irm ${SITE}/install.ps1 | iex`,
  unix: `curl -fsSL ${SITE}/install.sh | sh`
};

/**
 * Recommended install: one command per system, with a Copy button (copy.js). download.js puts the
 * visitor's system first. Files fetched by PowerShell or curl carry no "downloaded from the
 * internet" mark, so SmartScreen and Gatekeeper do not stop the first launch.
 */
export const installBlock = (id = 'install') => html`
          <div class="install" data-install data-copy-scope>
            <div class="install-row" data-install-os="windows">
              <p class="install-os"><span class="os-icon os-windows" aria-hidden="true"></span>Windows <span class="mute">· PowerShell</span></p>
              <div class="cmd"><code id="${id}-win">${esc(INSTALL.windows)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy-target="${id}-win" data-copy-label="Windows command" aria-label="Copy the Windows install command">Copy</button></div>
            </div>
            <div class="install-row" data-install-os="macos linux">
              <p class="install-os"><span class="os-icon os-apple" aria-hidden="true"></span><span class="os-icon os-linux" aria-hidden="true"></span>macOS and Linux <span class="mute">· Terminal</span></p>
              <div class="cmd"><code id="${id}-unix">${esc(INSTALL.unix)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy-target="${id}-unix" data-copy-label="macOS and Linux command" aria-label="Copy the macOS and Linux install command">Copy</button></div>
            </div>
            <p class="install-note small mute">Downloads the latest release from GitHub, checks its SHA-256 against <code>SHA256SUMS</code>, then installs it. The scripts are open source: <a href="/install.ps1">install.ps1</a> · <a href="/install.sh">install.sh</a> (<a href="${REPO}/tree/main/website/src">website/src</a>).</p>
            <p class="copy-status" role="status" aria-live="polite"></p>
          </div>`;

/** Closing call to action used at the bottom of inner pages. */
export const ctaPanel = (title = 'Get Kyro', text = `Version ${VERSION} · Free · Windows, macOS and Linux`) => html`
    <section class="section" aria-labelledby="cta-title">
      <div class="wrap">
        <div class="download-panel" data-reveal>
          <div class="aurora aurora-sm" aria-hidden="true"></div>
          <h2 id="cta-title">${title}</h2>
          <p class="dl-sub">${text}</p>
          ${osCards()}
          <p class="small mute"><a href="/download/">One-line install, all files and checksums</a></p>
        </div>
      </div>
    </section>`;

/**
 * A desktop app window around a real screenshot. src: /img/… (WebP); alt describes the screenshot
 * ('' when decorative). opts: w, h (intrinsic size, required), chrome: 'mac' | 'win' | 'none' (full
 * app screenshots already carry Kyro's own title bar), title (window title), cls (extra classes),
 * eager (above the fold), small: { src, w } a lighter file for narrow screens, sizes.
 */
export function window(src, alt, opts = {}) {
  const { w, h, chrome = 'mac', title = 'Kyro', cls = '', eager = false, small, sizes = '(max-width: 760px) 100vw, 1100px' } = opts;
  const bar =
    chrome === 'none'
      ? ''
      : `<div class="win-bar" aria-hidden="true">${chrome === 'mac' ? '<i class="tl"></i><i class="tl"></i><i class="tl"></i>' : ''}<span>${esc(title)}</span>${chrome === 'win' ? '<i class="wc wc-min"></i><i class="wc wc-max"></i><i class="wc wc-x"></i>' : ''}</div>`;
  const srcset = small ? ` srcset="${small.src} ${small.w}w, ${src} ${w}w" sizes="${sizes}"` : '';
  const load = eager ? ' fetchpriority="high"' : ' loading="lazy"';
  return `<figure class="win win-${chrome}${cls ? ' ' + cls : ''}">${bar}<img src="${src}"${srcset} width="${w}" height="${h}" alt="${esc(alt)}"${load} decoding="async"><span class="win-glare" aria-hidden="true"></span></figure>`;
}

/** A small native-looking dialog drawn in HTML (no screenshot), e.g. the system confirmation window. */
export const dialog = ({ title, rows, actions = ['Cancel', 'Confirm'], cls = '', note = '' }) =>
  `<div class="win win-win win-dialog${cls ? ' ' + cls : ''}" aria-hidden="true"><div class="win-bar"><span>${esc(title)}</span><i class="wc wc-x"></i></div><div class="dlg">${rows
    .map(([k, v, c = '']) => `<div class="dlg-row"><span>${esc(k)}</span><b class="${c}">${esc(v)}</b></div>`)
    .join('')}${note ? `<p class="dlg-note">${esc(note)}</p>` : ''}<div class="dlg-actions">${actions.map((a, i) => `<i${i === actions.length - 1 ? ' class="on"' : ''}>${esc(a)}</i>`).join('')}</div></div></div>`;

/** A framed real-app crop. src: /img/…; alt is required and describes what the screenshot shows. */
export const shot = ({ src, w, h, alt, cls = '', caption = '', title = 'Kyro' }) =>
  window(src, alt, { w, h, title, cls: `win-shot ${cls}`.trim() }) + (caption ? `<p class="small mute center">${caption}</p>` : '');
