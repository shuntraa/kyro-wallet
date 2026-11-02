// SPDX-License-Identifier: GPL-3.0-or-later
// Content of every page on kyrowallet.com.

import { SITE, VERSION, REPO, DL, FILES, esc, html, coin, pageHero, dlButton, osCards, installBlock, ctaPanel, shot, breadcrumbLd, window as win, dialog } from './layout.mjs';

const IMG = {
  portfolio: { src: '/img/win-portfolio.webp', w: 2160, h: 1350 },
  heroM: { src: '/img/shot-hero-m.webp', w: 1080, h: 945 },
  assets: { src: '/img/shot-assets.webp', w: 1425, h: 680, alt: 'Kyro asset list: Bitcoin, Ethereum, Dogecoin, Solana, Cardano and Ethereum on Arbitrum, each with price, 7-day trend, balance and share.' },
  vault: { src: '/img/shot-vault.webp', w: 545, h: 705, alt: 'Kyro vault panel: keys encrypted on this device, auto-lock timer, hardware wallet, unlimited approvals: none, recovery phrase: imported.' },
  swap: { src: '/img/win-swap.webp', w: 1400, h: 426, alt: 'Kyro swap form on Ethereum: You send USDT, you receive about ETH, service fee included in the rate.' },
  approval: { src: '/img/shot-approval.webp', w: 1250, h: 180, alt: 'Kyro token approval step: approved amount 200 USDC, exact; the unlimited approval switch is off.' },
  stakeSol: { src: '/img/shot-stake-sol.webp', w: 651, h: 337, alt: 'Kyro Solana staking card: delegate to a validator from a stake account in your name; activation and cooldown about one epoch each.' },
  stakeAda: { src: '/img/shot-stake-ada.webp', w: 647, h: 337, alt: 'Kyro Cardano staking card: delegate to a pool, ADA stays on your address; 2 ADA deposit returned when you stop.' },
  stakeTrx: { src: '/img/shot-stake-trx.webp', w: 652, h: 337, alt: 'Kyro TRON staking card: stake for energy or bandwidth, vote for Super Representatives; unfreeze takes 14 days.' }
};

const img = (i, extra = '') =>
  `<img src="${i.src}" width="${i.w}" height="${i.h}" alt="${esc(i.alt || '')}" loading="lazy" decoding="async"${extra}>`;

const deck = (labelled = true) => html`
            <div class="deck"${labelled ? '' : ' aria-hidden="true"'}>
              ${img(labelled ? IMG.stakeSol : { ...IMG.stakeSol, alt: '' })}
              ${img(labelled ? IMG.stakeAda : { ...IMG.stakeAda, alt: '' })}
              ${img(labelled ? IMG.stakeTrx : { ...IMG.stakeTrx, alt: '' })}
            </div>`;

const signMock = () => html`
            <div class="sign-mock" aria-hidden="true">
              <div class="sm-title">Kyro · confirm transaction</div>
              <div class="sm-row"><span>Send</span><b class="num">0.25 ETH</b></div>
              <div class="sm-row"><span>To</span><b class="mono">0x3f5C…9a1E</b></div>
              <div class="sm-row"><span>Network fee</span><b class="num">0.00018 ETH</b></div>
              <div class="sm-actions"><i>Cancel</i><i class="on">Confirm</i></div>
            </div>`;

const layers = () => html`
        <div class="layers" data-reveal role="list" aria-label="Kyro's three layers">
          <div class="layer" role="listitem">
            <span class="layer-n">01</span>
            <div><b>Interface</b><span>Sandboxed web view. Never sees a key.</span></div>
          </div>
          <div class="layer" role="listitem">
            <span class="layer-n">02</span>
            <div><b>App shell</b><span>Tor, auto-lock, system confirmation window.</span></div>
          </div>
          <div class="layer layer-core" role="listitem">
            <span class="layer-n">03</span>
            <div><b>Rust core</b><span>Encryption, keys and signing.</span></div>
          </div>
        </div>`;

const docLinks = () => html`
          <div class="doc-links">
            <a href="${REPO}/blob/main/SECURITY.md">Threat model</a>
            <a href="${REPO}/blob/main/docs/NETWORK.md">Servers contacted</a>
            <a href="${REPO}/blob/main/docs/ARCHITECTURE.md">Architecture</a>
          </div>`;

const chainLinks = (list) =>
  list.map((c) => `<li><a class="c-${c.slug}" href="/chains/${c.slug}/">${coin(c)}<span class="chain-name">${esc(c.name)}<small>${esc(c.ticker)}</small></span></a></li>`).join('\n          ');

const yesNo = (v) => (v ? '<span class="yes" role="img" aria-label="Yes"></span>' : '<span class="no" role="img" aria-label="No"></span>');

function matrix(chains) {
  const rows = chains
    .map(
      (c) =>
        `<tr><th scope="row"><a class="c-${c.slug}" href="/chains/${c.slug}/">${coin(c)}${esc(c.name)}</a></th><td>${yesNo(c.features.send)}</td><td>${yesNo(c.features.swap)}</td><td>${yesNo(c.features.staking)}</td><td>${yesNo(c.features.hardware)}</td></tr>`
    )
    .join('\n                ');
  return html`
          <div class="table-wrap" data-reveal>
            <table class="matrix">
              <caption class="visually-hidden">What Kyro supports on each blockchain</caption>
              <thead>
                <tr><th scope="col">Blockchain</th><th scope="col">Send</th><th scope="col">Swap</th><th scope="col">Stake</th><th scope="col">Hardware</th></tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </div>`;
}

export const listNames = (arr) => (arr.length < 2 ? arr.join('') : arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1]);

const APP_ID = `${SITE}/#app`;
const ORG_ID = `${SITE}/#org`;
const WEB_ID = `${SITE}/#website`;

function webPage(path, name, description, trail) {
  return [
    { '@type': 'WebPage', '@id': `${SITE}${path}#page`, url: SITE + path, name, description, isPartOf: { '@id': WEB_ID }, about: { '@id': APP_ID }, inLanguage: 'en' },
    breadcrumbLd(trail)
  ];
}

function appLd(chains) {
  return {
    '@type': 'SoftwareApplication',
    '@id': APP_ID,
    name: 'Kyro Wallet',
    alternateName: 'Kyro',
    description: 'Free, open-source, non-custodial crypto wallet for Windows, macOS and Linux. Keys are encrypted on your device.',
    applicationCategory: 'FinanceApplication',
    applicationSubCategory: 'Cryptocurrency wallet',
    operatingSystem: 'Windows, macOS, Linux',
    softwareVersion: VERSION,
    license: 'https://spdx.org/licenses/GPL-3.0-or-later.html',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    downloadUrl: `${REPO}/releases/latest`,
    installUrl: `${SITE}/download/`,
    screenshot: `${SITE}/img/win-portfolio.webp`,
    url: `${SITE}/`,
    publisher: { '@id': ORG_ID },
    featureList: [
      `Send and receive on ${chains.length} blockchains`,
      'Token swaps with fees from 0.7%, included in the amount you receive',
      'Staking for SOL, ADA and TRX',
      'Ledger and Trezor hardware wallets',
      'Built-in Tor, no personal data collected',
      'Transactions decoded and confirmed in a system window'
    ]
  };
}

// App windows staged on the home page. Screenshots come from the app's demo mode (website/src/capture.mjs).
const W = {
  send: { src: '/img/win-send.webp', w: 1416, h: 886 },
  staking: { src: '/img/win-staking.webp', w: 1600, h: 1000 },
  status: { src: '/img/win-statusbar.webp', w: 1400, h: 40 }
};

const confirmDialog = (cls = '') =>
  dialog({
    title: 'Kyro · Confirm transaction',
    cls,
    rows: [['Send', '0.25 ETH', 'num'], ['To', '0x3f5C…9a1E', 'mono'], ['Network', 'Ethereum'], ['Network fee', '0.00018 ETH', 'num']],
    note: 'Decoded by the Rust core. Nothing is sent until you confirm.'
  });

const tourRow = (id, eyebrow, h, text, more, stage, flip = false) => html`
      <div class="tour-row${flip ? ' tour-flip' : ''}">
        <div class="tour-text" data-reveal>
          <p class="eyebrow">${eyebrow}</p>
          <h2 id="${id}">${h}</h2>
          <p>${text}</p>
          ${more}
        </div>
        <div class="stage" data-stage data-reveal>${stage}</div>
      </div>`;

function tour() {
  return html`
    <section class="section tour" aria-label="A look at the app">
      <div class="wrap">
      ${tourRow('t-swap', 'Swap', 'Swap inside the wallet', 'Kyro asks several providers for a quote and shows what you receive after fees. Token approvals are for the exact amount unless you change it.', '<a class="more" href="/fees/">How swap fees work</a>',
        win(IMG.swap.src, IMG.swap.alt, { w: IMG.swap.w, h: IMG.swap.h, title: 'Kyro · Swap', cls: 'win-main' }) + win(IMG.approval.src, IMG.approval.alt, { w: IMG.approval.w, h: IMG.approval.h, title: 'Approval', cls: 'win-side win-low' }))}
      ${tourRow('t-send', 'Send', 'Read it before you sign it', 'The Rust core decodes every transaction and opens a separate system window with the amount, the recipient and the fee. Unusual transactions ask a second time.', '<a class="more" href="/security/">How signing works</a>',
        win(W.send.src, 'Kyro send screen: from account, recipient, amount, network fee options and a review panel.', { w: W.send.w, h: W.send.h, chrome: 'none', cls: 'win-main' }) + confirmDialog('win-side win-front'), true)}
      ${tourRow('t-assets', 'Assets', 'Every account in one list', 'Prices, 7-day trends and balances for all your blockchains, from a single recovery phrase. Add as many accounts as you need.', '<a class="more" href="/chains/">Supported blockchains</a>',
        win(IMG.assets.src, IMG.assets.alt, { w: IMG.assets.w, h: IMG.assets.h, title: 'Kyro · Assets', cls: 'win-main' }) + win(IMG.vault.src, '', { w: IMG.vault.w, h: IMG.vault.h, title: 'Vault', cls: 'win-side win-tall' }))}
      ${tourRow('t-stake', 'Staking', 'Stake from your own accounts', 'Delegate SOL, ADA and TRX to a validator, a pool or a Super Representative. Kyro takes no fee on staking.', '<a class="more" href="/features/">Staking details</a>',
        win(W.staking.src, 'Kyro staking overview: Solana, Cardano and TRON cards.', { w: W.staking.w, h: W.staking.h, chrome: 'none', cls: 'win-main' }), true)}
      ${tourRow('t-hw', 'Hardware and privacy', 'Ledger, Trezor and Tor', 'Keep keys on a hardware wallet and confirm on the device. Network traffic goes through the built-in Tor client, on by default.', '<a class="more" href="/security/">Privacy and network</a>',
        win(IMG.vault.src, IMG.vault.alt, { w: IMG.vault.w, h: IMG.vault.h, title: 'Kyro · Vault', cls: 'win-main win-narrow' }) +
          dialog({ title: 'Trezor Safe 7', cls: 'win-side win-front', rows: [['Action', 'Confirm on device'], ['Address', 'bc1q…naard', 'mono']], actions: ['Waiting for the device'] }))}
      </div>
    </section>`;
}

function coinWall(chains) {
  const half = Math.ceil(chains.length / 2);
  const row = (list, cls) => {
    const items = (hidden) =>
      list.map((c) => `<li${hidden ? ' aria-hidden="true"' : ''}><a class="coin-tile c-${c.slug}" href="/chains/${c.slug}/"${hidden ? ' tabindex="-1"' : ''}>${coin(c)}<span>${esc(c.name)}</span></a></li>`).join('');
    return `<ul class="coin-row ${cls}">${items(false)}${items(true)}</ul>`;
  };
  return `<nav class="coin-wall" aria-label="All supported blockchains" data-reveal>${row(chains.slice(0, half), 'cr-a')}${row(chains.slice(half), 'cr-b')}</nav>`;
}

/** Usage counters, filled by stats.js from the public `stats` branch; hidden if unavailable. */
const usage = () => `<p class="usage" data-usage hidden>
          <span data-usage-item="weekly_active" hidden><strong data-usage-n></strong> active wallets this week</span>
          <span data-usage-item="downloads_week" hidden><strong data-usage-n></strong> downloads this week</span>
          <span class="usage-total" data-usage-item="downloads_total" hidden><strong data-usage-n></strong> downloads in total</span>
        </p>`;

export function home(chains) {
  const n = chains.length;
  const path = '/';
  const title = 'Kyro Wallet: open-source crypto wallet for Windows, macOS and Linux';
  const description = `Free, open-source, non-custodial wallet for Bitcoin, Ethereum, Solana and ${n - 3} more blockchains. Send, swap and stake. Your keys stay on your computer.`;
  const rail = chains
    .map((c) => `<li><a class="c-${c.slug}" href="/chains/${c.slug}/">${coin(c)}${esc(c.name)}</a></li>`)
    .join('');
  const railCopy = chains
    .map((c) => `<li aria-hidden="true"><a class="c-${c.slug}" href="/chains/${c.slug}/" tabindex="-1">${coin(c)}${esc(c.name)}</a></li>`)
    .join('');

  const body = html`
    <section class="hero" aria-labelledby="hero-title">
      <div class="aurora" aria-hidden="true"></div>
      <div class="wrap hero-inner">
        <a class="badge" href="${REPO}" data-reveal>
          <span class="badge-tag">${VERSION}</span>
          Free and open source
          <span class="badge-arrow" aria-hidden="true">→</span>
        </a>
        <h1 id="hero-title" data-reveal><span class="line">Your keys.</span> <span class="line grad">Your crypto.</span></h1>
        <p class="lead hero-lead" data-reveal>A desktop wallet for Bitcoin, Ethereum, Solana and ${n - 3} more blockchains. Send, swap and stake, with your keys kept on your own computer.</p>
        <div class="hero-cta" data-reveal>
          ${dlButton()}
          <a class="link-muted" href="/download/" data-dl-other>Windows, macOS and Linux</a>
        </div>
        ${usage()}
      </div>

      <div class="wrap">
        <div class="stage stage-hero" id="showcase">
          <div class="horizon" aria-hidden="true"></div>
          ${win(IMG.portfolio.src, "Kyro's portfolio screen: total value, price chart, asset list with Bitcoin, Ethereum, Dogecoin, Solana and Cardano, and vault status.", { w: IMG.portfolio.w, h: IMG.portfolio.h, chrome: 'none', cls: 'win-hero', eager: true, small: { src: '/img/win-portfolio-sm.webp', w: 1080 }, sizes: '(max-width: 760px) 100vw, 1180px' })}
          ${win(IMG.vault.src, '', { w: IMG.vault.w, h: IMG.vault.h, title: 'Vault', cls: 'win-float win-f1' })}
          ${win(IMG.swap.src, '', { w: IMG.swap.w, h: IMG.swap.h, title: 'Kyro · Swap', cls: 'win-float win-f2' })}
        </div>
      </div>

      <div class="wrap">
        <ul class="trust" data-reveal-group>
          <li><strong>Open source</strong><span>GPL-3.0, on GitHub</span></li>
          <li><strong>Self-custody</strong><span>No account, no server</span></li>
          <li><strong>Ledger &amp; Trezor</strong><span>Hardware wallet support</span></li>
          <li><strong>Tor built in</strong><span>No tracking, no personal data</span></li>
        </ul>
      </div>

      <nav class="rail" aria-label="Supported blockchains">
        <ul class="rail-track">${rail}${railCopy}</ul>
      </nav>
    </section>
${tour()}

    <section class="section seam" id="features" aria-labelledby="features-title">
      <div class="wrap">
        <div class="head-center" data-reveal>
          <p class="eyebrow">Features</p>
          <h2 id="features-title">Also in the app</h2>
          <p>Small things that matter when you hold crypto yourself.</p>
        </div>

        <div class="bento">
          <article class="card card-mini spot" data-reveal>
            <span class="mini-icon ic-accounts" aria-hidden="true"></span>
            <h3>Many accounts</h3>
            <p>Create as many as you need and move funds between them in two clicks.</p>
          </article>

          <article class="card card-mini spot" data-reveal>
            <span class="mini-icon ic-hw" aria-hidden="true"></span>
            <h3>Hardware wallets</h3>
            <p>Ledger and Trezor, including Trezor Safe 7.</p>
          </article>

          <article class="card card-mini spot" data-reveal>
            <span class="mini-icon ic-shield" aria-hidden="true"></span>
            <h3>Scam protection</h3>
            <p>Address-poisoning alerts, clipboard checks and exact token approvals.</p>
          </article>

          <article class="card card-mini spot" data-reveal>
            <span class="mini-icon ic-tor" aria-hidden="true"></span>
            <h3>Private by default</h3>
            <p>Built-in Tor, no personal data collected. Use your own nodes if you like.</p>
          </article>
        </div>
        <p class="center"><a class="more" href="/features/">All features</a></p>
      </div>
    </section>

    <section class="section seam band" aria-labelledby="steps-title">
      <div class="wrap">
        <div class="head-center" data-reveal>
          <p class="eyebrow">Getting started</p>
          <h2 id="steps-title">Three steps, no account</h2>
        </div>
        <ol class="steps" data-reveal-group>
          <li>
            <h3>Install</h3>
            <p>Install Kyro with one command, or download it from GitHub for Windows, macOS or Linux. <a href="/download/#verify">Check the SHA-256</a> if you download the file yourself.</p>
          </li>
          <li>
            <h3>Create or import</h3>
            <p>Make a new 12 or 24-word recovery phrase, or import yours. It is encrypted with your password, on your computer.</p>
          </li>
          <li>
            <h3>Send, swap, stake</h3>
            <p>Every transaction opens a system window that shows what you are signing. Nothing is sent until you confirm.</p>
          </li>
        </ol>
      </div>
    </section>

    <section class="section seam" id="security" aria-labelledby="security-title">
      <div class="wrap split">
        <div class="split-text" data-reveal>
          <p class="eyebrow">Security</p>
          <h2 id="security-title">Built so you don’t have to trust us</h2>
          <p>Kyro is open source. Anyone can read the code and build the app themselves.</p>
          <ul class="checks">
            <li>Keys are encrypted on your device and never leave the Rust core.</li>
            <li>Every signature needs your password and a confirmation in a system window.</li>
            <li>Unusual transactions ask for a second confirmation.</li>
            <li>Traffic goes over Tor. Every server Kyro contacts is listed publicly.</li>
          </ul>
          <a class="more" href="/security/">How Kyro protects your keys</a>
        </div>
        ${layers()}
      </div>
    </section>

    <section class="section seam band" id="chains" aria-labelledby="chains-title">
      <div class="wrap">
        <div class="head-center" data-reveal>
          <p class="eyebrow">Blockchains</p>
          <h2 id="chains-title">${n} blockchains. 220+ tokens.</h2>
          <p>All in the same wallet, from the same recovery phrase.</p>
        </div>
      </div>
      ${coinWall(chains)}
      <div class="wrap">
        <p class="center fee-note">Swaps from 0.7%, built into the rate you see.</p>
        <p class="center"><a class="more" href="/chains/">What works on each blockchain</a></p>
      </div>
    </section>

    <section class="section seam" id="fees" aria-labelledby="fees-title">
      <div class="wrap">
        <div class="head-center" data-reveal>
          <p class="eyebrow">Fees</p>
          <h2 id="fees-title">Simple fees</h2>
          <p>Kyro is free. Only swaps carry a fee, built into the rate.</p>
        </div>
        <div class="fee-cards" data-reveal-group>
          <div class="fee-card spot">
            <span class="fee-value">0%</span>
            <span class="fee-name">Send and receive</span>
            <span class="fee-desc">Only the network fee.</span>
          </div>
          <div class="fee-card spot">
            <span class="fee-value">0%</span>
            <span class="fee-name">Staking</span>
            <span class="fee-desc">Only the network fee.</span>
          </div>
          <div class="fee-card fee-accent spot">
            <span class="fee-value"><span class="fee-from">from</span> 0.7%</span>
            <span class="fee-name">Swaps</span>
            <span class="fee-desc">Built into the rate you see.</span>
          </div>
        </div>
        <p class="center"><a class="more" href="/fees/">Swap fee table and an example</a></p>
      </div>
    </section>

    <section class="section seam" id="download" aria-labelledby="download-title">
      <div class="wrap">
        <div class="download-panel" data-reveal>
          <div class="aurora aurora-sm" aria-hidden="true"></div>
          <h2 id="download-title">Get Kyro</h2>
          <p class="dl-sub">Version ${VERSION} · Free · Windows, macOS and Linux</p>
          ${installBlock('home')}
          <p class="dl-alt">Or download the file</p>
          ${osCards()}
          <p class="small mute">Also: <a href="${DL}${FILES.msi}">.msi</a> · <a href="${DL}${FILES.deb}">.deb</a> · <a href="${DL}${FILES.sums}">SHA256SUMS</a> · <a href="/download/#first-launch">Opening a downloaded file</a> · <a href="${REPO}/releases/latest">Release notes</a></p>
        </div>
      </div>
    </section>

    <section class="section seam" aria-labelledby="faq-title">
      <div class="wrap">
        <div class="head-center" data-reveal>
          <p class="eyebrow">Questions</p>
          <h2 id="faq-title">Short answers</h2>
        </div>
        <div class="faq" data-reveal>
          ${faqItems(FAQ.flatMap((g) => g.items).filter((i) => i.home), chains)}
        </div>
        <p class="center"><a class="more" href="/faq/">All questions</a></p>
      </div>
    </section>

    <section class="section seam band" id="support" aria-labelledby="support-title">
      <div class="wrap">
        <div class="head-center" data-reveal>
          <p class="eyebrow">Support</p>
          <h2 id="support-title">Support the project</h2>
          <p>Kyro is free. Donations help keep it going. You can also <a href="https://github.com/sponsors/shuntraa">sponsor on GitHub</a>.</p>
        </div>
        <div class="donate" data-reveal>
          <table class="stack">
            <thead>
              <tr><th scope="col">Network</th><th scope="col">Address</th><th scope="col"><span class="visually-hidden">Action</span></th></tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Bitcoin</th>
                <td data-label="Address"><span class="address" id="addr-btc">bc1qta8efdy72ge9qy8yj8s0ckwar0lg44ggwnaard</span></td>
                <td class="copy-cell"><button class="btn btn-ghost btn-sm" type="button" data-copy-target="addr-btc" aria-label="Copy the Bitcoin address">Copy</button></td>
              </tr>
              <tr>
                <th scope="row">Ethereum &amp; EVM</th>
                <td data-label="Address"><span class="address" id="addr-eth">0x86cD9af8067fF5e0001c709a550cD62b5e968B44</span></td>
                <td class="copy-cell"><button class="btn btn-ghost btn-sm" type="button" data-copy-target="addr-eth" aria-label="Copy the Ethereum and EVM address">Copy</button></td>
              </tr>
              <tr>
                <th scope="row">Solana</th>
                <td data-label="Address"><span class="address" id="addr-sol">ptsbLdrhmEfC2eQ9gj4aieF4irdhQqYzK1fdNwHBZcM</span></td>
                <td class="copy-cell"><button class="btn btn-ghost btn-sm" type="button" data-copy-target="addr-sol" aria-label="Copy the Solana address">Copy</button></td>
              </tr>
              <tr>
                <th scope="row">Litecoin</th>
                <td data-label="Address"><span class="address" id="addr-ltc">LWePW8iwa8RxxYB6av4KBriBNkRgLWvNyw</span></td>
                <td class="copy-cell"><button class="btn btn-ghost btn-sm" type="button" data-copy-target="addr-ltc" aria-label="Copy the Litecoin address">Copy</button></td>
              </tr>
              <tr>
                <th scope="row">Dogecoin</th>
                <td data-label="Address"><span class="address" id="addr-doge">DKCSjtypvD9qg3R175YdijmwvKh5FnAU14</span></td>
                <td class="copy-cell"><button class="btn btn-ghost btn-sm" type="button" data-copy-target="addr-doge" aria-label="Copy the Dogecoin address">Copy</button></td>
              </tr>
              <tr>
                <th scope="row">TRON</th>
                <td data-label="Address"><span class="address" id="addr-trx">TT9j25bsbBAgxCDEXTN1cpjcD54Jz51pES</span></td>
                <td class="copy-cell"><button class="btn btn-ghost btn-sm" type="button" data-copy-target="addr-trx" aria-label="Copy the TRON address">Copy</button></td>
              </tr>
              <tr>
                <th scope="row">Cardano</th>
                <td data-label="Address"><span class="address" id="addr-ada">addr1qy9d3jctafj2cgfm8sgllfjkrxrgxn9mz9dy0qzxuwscx6c2mr9sh6ny4ssnk0q3l7n9vxvxsdxtky26g7qydcapsd4sux3dj3</span></td>
                <td class="copy-cell"><button class="btn btn-ghost btn-sm" type="button" data-copy-target="addr-ada" aria-label="Copy the Cardano address">Copy</button></td>
              </tr>
            </tbody>
          </table>
          <p class="copy-status" id="copy-status" role="status" aria-live="polite"></p>
        </div>
      </div>
    </section>`;

  return {
    path,
    title,
    description,
    body,
    scripts: ['/download.js', '/copy.js', '/stats.js'],
    preload: '<link rel="preload" href="/img/win-portfolio.webp" as="image" media="(min-width: 761px)">\n  <link rel="preload" href="/img/win-portfolio-sm.webp" as="image" media="(max-width: 760px)">',
    ld: [
      {
        '@type': 'Organization',
        '@id': ORG_ID,
        name: 'Kyro Wallet',
        url: `${SITE}/`,
        logo: `${SITE}/favicon.svg`,
        sameAs: [REPO]
      },
      { '@type': 'WebSite', '@id': WEB_ID, url: `${SITE}/`, name: 'Kyro Wallet', publisher: { '@id': ORG_ID }, inLanguage: 'en' },
      appLd(chains)
    ]
  };
}

export function features(chains) {
  const path = '/features/';
  const trail = [['/', 'Home'], [path, 'Features']];
  const title = 'Features: send, swap, stake and hardware wallets | Kyro Wallet';
  const description = `What Kyro Wallet does: one portfolio for ${chains.length} blockchains, token swaps, SOL, ADA and TRX staking, Ledger and Trezor, built-in Tor and transactions you can read before you sign.`;
  const hw = chains.filter((c) => c.features.hardware).map((c) => c.name);

  const body = html`
    ${pageHero({
      trail,
      eyebrow: 'Features',
      h1: 'What Kyro does',
      lead: `Send, receive, swap and stake on ${chains.length} blockchains from one recovery phrase. Every transaction is decoded and confirmed in a system window before it is signed.`
    })}

    <section class="section section-tight" aria-labelledby="f-portfolio">
      <div class="wrap feature-row">
        <div class="feature-text" data-reveal>
          <p class="eyebrow">Portfolio</p>
          <h2 id="f-portfolio">All your coins in one list</h2>
          <p>One screen for every blockchain: total value, a price chart from one day to all time, and each asset with its balance, 7-day trend and share of the total.</p>
          <ul class="checks">
            <li>Market tab with the top 200 coins, and favourites.</li>
            <li>Search assets and addresses with Ctrl K.</li>
            <li>Allocation by asset, and a vault panel with your security status.</li>
          </ul>
        </div>
        <div class="feature-visual" data-reveal>
          ${shot({ ...IMG.assets, cls: 'frame-glow' })}
        </div>
      </div>
    </section>

    <section class="section seam" aria-labelledby="f-swap">
      <div class="wrap feature-row flip">
        <div class="feature-text" data-reveal>
          <p class="eyebrow">Swap</p>
          <h2 id="f-swap">Swaps with the fee in plain sight</h2>
          <p>Kyro asks several providers for a quote and picks the best price after fees. You see the amount you send and the amount you receive. The Kyro swap fee, from 0.7%, is already taken out of the amount you receive. <a href="/fees/">How it is calculated</a>.</p>
          <ul class="checks">
            <li>Token approvals are for the exact amount. Unlimited approvals are off unless you turn them on.</li>
            <li>The transaction is simulated just before you sign it.</li>
            <li>Maximum slippage of 0.1%, 0.5%, 1% or your own value.</li>
            <li>The provider’s transaction is decoded and checked: recipient, minimum amount and fee.</li>
          </ul>
        </div>
        <div class="feature-visual" data-reveal>
          ${shot({ ...IMG.swap, cls: 'frame-glow frame-fade' })}
        </div>
      </div>
    </section>

    <section class="section seam" aria-labelledby="f-stake">
      <div class="wrap feature-row">
        <div class="feature-text" data-reveal>
          <p class="eyebrow">Staking</p>
          <h2 id="f-stake">Stake SOL, ADA and TRX</h2>
          <p>Delegate from your own accounts. Your coins never go to Kyro or to a pooled contract.</p>
          <ul class="checks">
            <li><b>Solana:</b> a stake account in your name, delegated to a validator. Activation and cooldown take about two days each.</li>
            <li><b>Cardano:</b> delegate to a pool. Your ADA stays on your address and stays spendable. 2 ADA deposit, returned when you stop.</li>
            <li><b>TRON:</b> stake for energy or bandwidth, then vote for Super Representatives. Unstaking takes 14 days.</li>
          </ul>
          <p class="small mute">No slashing on these three networks: a validator, pool or SR cannot take your funds. Rewards depend on them and are never guaranteed.</p>
        </div>
        <div class="feature-visual deck-wrap" data-reveal>
          ${deck()}
        </div>
      </div>
    </section>

    <section class="section seam" aria-labelledby="f-sign">
      <div class="wrap feature-row flip">
        <div class="feature-text" data-reveal>
          <p class="eyebrow">Transaction review</p>
          <h2 id="f-sign">Read it before you sign it</h2>
          <p>The Rust core decodes each transaction and shows it in a native system window, outside the app’s web view. Sign only after you have read the amount, the recipient and the fee.</p>
          <ul class="checks">
            <li>Contract calls, token approvals and high fees ask for a second confirmation.</li>
            <li>On Bitcoin: unknown scripts, OP_RETURN data and fees above 100 sat/vB too.</li>
            <li>Address-poisoning alerts and clipboard checks before you send.</li>
          </ul>
        </div>
        <div class="feature-visual" data-reveal>
          <div class="card card-sign spot">${signMock()}</div>
        </div>
      </div>
    </section>

    <section class="section seam" aria-labelledby="f-hw">
      <div class="wrap feature-row">
        <div class="feature-text" data-reveal>
          <p class="eyebrow">Hardware wallets</p>
          <h2 id="f-hw">Ledger and Trezor</h2>
          <p>Keep your keys on a hardware wallet and use Kyro as the screen. Trezor Safe 7 pairs with a code.</p>
          <ul class="checks">
            <li>Supported on ${listNames(hw)}.</li>
            <li>Software accounts and hardware accounts side by side.</li>
          </ul>
        </div>
        <div class="feature-visual" data-reveal>
          ${shot({ ...IMG.vault, cls: 'frame-narrow frame-glow' })}
        </div>
      </div>
    </section>

    <section class="section seam band" aria-labelledby="f-more">
      <div class="wrap">
        <div class="head-center" data-reveal>
          <p class="eyebrow">And also</p>
          <h2 id="f-more">The details that matter</h2>
        </div>
        <div class="bento" data-reveal-group>
          <article class="card card-mini spot">
            <span class="mini-icon ic-accounts" aria-hidden="true"></span>
            <h3>Many accounts</h3>
            <p>Several accounts per blockchain from the same phrase. Move funds between them in two clicks.</p>
          </article>
          <article class="card card-mini spot">
            <span class="mini-icon ic-tor" aria-hidden="true"></span>
            <h3>Tor built in</h3>
            <p>All traffic goes over Tor, with a separate circuit per blockchain. If Tor is down, Kyro does not fall back to a direct connection.</p>
          </article>
          <article class="card card-mini spot">
            <span class="mini-icon ic-eye" aria-hidden="true"></span>
            <h3>No personal data</h3>
            <p>No account and no analytics. A weekly anonymous count over Tor, which you can turn off. Every server Kyro contacts is listed on GitHub.</p>
          </article>
          <article class="card card-mini spot">
            <span class="mini-icon ic-lock" aria-hidden="true"></span>
            <h3>Auto-lock</h3>
            <p>The vault locks itself when the auto-lock timer runs out. Unlocking needs your password.</p>
          </article>
          <article class="card card-mini spot">
            <span class="mini-icon ic-send" aria-hidden="true"></span>
            <h3>Your own servers</h3>
            <p>Point each blockchain at your own node or server. Kyro checks it is on the right network first.</p>
          </article>
          <article class="card card-mini spot">
            <span class="mini-icon ic-shield" aria-hidden="true"></span>
            <h3>Approvals overview</h3>
            <p>The vault panel shows whether any unlimited token approval is active.</p>
          </article>
          <article class="card card-mini spot">
            <span class="mini-icon ic-swap" aria-hidden="true"></span>
            <h3>${chains.length} blockchains</h3>
            <p>Bitcoin, Ethereum and EVM chains, Solana, TRON, Cardano, XRP Ledger and more. <a href="/chains/">See the list</a>.</p>
          </article>
          <article class="card card-mini spot">
            <span class="mini-icon ic-stake" aria-hidden="true"></span>
            <h3>Open source</h3>
            <p>GPL-3.0-or-later. Read the code, build it yourself, or change it.</p>
          </article>
        </div>
      </div>
    </section>
    ${ctaPanel()}`;

  return { path, title, description, body, scripts: ['/download.js'], ld: webPage(path, 'Kyro Wallet features', description, trail) };
}

export function security() {
  const path = '/security/';
  const trail = [['/', 'Home'], [path, 'Security']];
  const title = 'Security: how Kyro Wallet protects your keys';
  const description =
    'Keys encrypted on your device with Argon2id and XChaCha20-Poly1305, signing in a Rust core, a system confirmation window, Tor by default. What Kyro protects against, what it cannot, and its audit status.';

  const body = html`
    ${pageHero({
      trail,
      eyebrow: 'Security',
      h1: 'How Kyro protects your keys',
      lead: 'Kyro keeps your keys encrypted on your computer and asks you to confirm every signature in a system window. Here is what that covers, and what it does not.'
    })}

    <section class="section section-tight" aria-labelledby="s-layers">
      <div class="wrap split">
        <div class="split-text" data-reveal>
          <p class="eyebrow">Design</p>
          <h2 id="s-layers">Three layers, one place for keys</h2>
          <p>The interface you click is a sandboxed web view. It never sees a key. Keys live only in the Rust core, which encrypts them, signs and returns the signed transaction.</p>
          <ul class="checks">
            <li>Recovery phrase and keys encrypted with your password: Argon2id, then XChaCha20-Poly1305.</li>
            <li>Stored only on your computer. No copy on a server, no cloud backup.</li>
            <li>Standard 12 or 24-word BIP39 recovery phrases.</li>
          </ul>
        </div>
        ${layers()}
      </div>
    </section>

    <section class="section seam" aria-labelledby="s-sign">
      <div class="wrap feature-row flip">
        <div class="feature-text" data-reveal>
          <p class="eyebrow">Before you sign</p>
          <h2 id="s-sign">Nothing is signed without you</h2>
          <p>Every signature needs your password and a confirmation in a native system window, drawn by the app shell rather than the web view.</p>
          <ul class="checks">
            <li>The window shows the decoded transaction: amount, recipient, fee, account.</li>
            <li>Unusual transactions ask for a second confirmation: contract calls, any token approval, value sent to a contract, an unknown chain ID, high fees.</li>
            <li>Token approvals are for the exact amount by default.</li>
            <li>Address-poisoning alerts and clipboard checks before you send.</li>
          </ul>
        </div>
        <div class="feature-visual" data-reveal>
          ${shot({ ...IMG.approval, cls: 'frame-glow hide-sm' })}
          <div class="card card-sign spot">${signMock()}</div>
        </div>
      </div>
    </section>

    <section class="section seam" aria-labelledby="s-net">
      <div class="wrap feature-row">
        <div class="feature-text" data-reveal>
          <p class="eyebrow">Network</p>
          <h2 id="s-net">Private by default</h2>
          <p>Kyro talks to blockchains over Tor, which is built into the app. Your IP address is not linked to your addresses.</p>
          <ul class="checks">
            <li>A separate Tor circuit per blockchain.</li>
            <li>If Tor fails, Kyro stops. It never falls back to a direct connection.</li>
            <li>Every server Kyro contacts is listed in <a href="${REPO}/blob/main/docs/NETWORK.md">NETWORK.md</a>.</li>
            <li>Use your own node or server for each blockchain.</li>
            <li>No personal data, no analytics, no account. Only an anonymous weekly count over Tor, which you can turn off.</li>
          </ul>
        </div>
        <div class="feature-visual" data-reveal>
          ${shot({ ...IMG.vault, cls: 'frame-narrow frame-glow' })}
        </div>
      </div>
    </section>

    <section class="section seam band" aria-labelledby="s-limits">
      <div class="wrap">
        <div class="prose" data-reveal>
          <p class="eyebrow">Limits</p>
          <h2 id="s-limits">What Kyro cannot protect you from</h2>
          <p>No wallet can. Knowing these helps you avoid them.</p>
          <ul class="checks minus">
            <li>Malware with full control of your computer while the wallet is unlocked.</li>
            <li>Anyone who gets your recovery phrase. Kyro never asks for it outside the app, and neither should anyone else.</li>
            <li>A transaction you read and confirm. Check the recipient and amount in the system window every time.</li>
            <li>A lost recovery phrase. Kyro has no copy and cannot reset it. Write it on paper and keep it offline.</li>
          </ul>

          <h2 id="s-audit">Audit status</h2>
          <p>Kyro is open source under GPL-3.0-or-later, so anyone can review it. An internal security review has been done. <b>No external audit has been published yet.</b> Kyro is provided without warranty, as stated in the license.</p>
          ${docLinks()}

          <h2 id="report">Report a vulnerability</h2>
          <p>Please report security issues privately through <a href="${REPO}/security">GitHub security advisories</a>, not in a public issue. The <a href="${REPO}/blob/main/SECURITY.md">security policy</a> explains what is in scope and how reports are handled.</p>
        </div>
      </div>
    </section>
    ${ctaPanel()}`;

  return { path, title, description, body, scripts: ['/download.js'], ld: webPage(path, 'Kyro Wallet security', description, trail) };
}

export function fees() {
  const path = '/fees/';
  const trail = [['/', 'Home'], [path, 'Fees']];
  const title = 'Fees: free to use, swaps from 0.7% | Kyro Wallet';
  const description =
    'Kyro Wallet is free. Sending, receiving and staking cost only the network fee. Swaps carry a fee from 0.7% to 5% depending on the swap value, already included in the amount you receive.';

  const body = html`
    ${pageHero({
      trail,
      eyebrow: 'Fees',
      h1: 'Kyro is free. Swaps from 0.7%.',
      lead: 'Downloading and using Kyro costs nothing. Sending, receiving and staking cost only the blockchain’s network fee. Swaps carry a Kyro fee that depends on the swap value, already included in the amount you receive.'
    })}

    <section class="section section-tight" aria-label="Fee summary">
      <div class="wrap">
        <div class="fee-cards" data-reveal-group>
          <div class="fee-card spot">
            <span class="fee-value">0%</span>
            <span class="fee-name">Send and receive</span>
            <span class="fee-desc">You pay the network fee only.</span>
          </div>
          <div class="fee-card spot">
            <span class="fee-value">0%</span>
            <span class="fee-name">Staking</span>
            <span class="fee-desc">SOL, ADA, TRX. Network fee only.</span>
          </div>
          <div class="fee-card fee-accent spot">
            <span class="fee-value"><span class="fee-from">from</span> 0.7%</span>
            <span class="fee-name">Swaps</span>
            <span class="fee-desc">Included in the amount you receive.</span>
          </div>
        </div>
      </div>
    </section>

    <section class="section seam" aria-labelledby="fee-schedule">
      <div class="wrap">
        <div class="prose" data-reveal>
          <h2 id="fee-schedule">Swap fee by swap value</h2>
          <p>The Kyro fee is a percentage of the swap. Small swaps pay a higher rate and large swaps a lower one. The value is the size of the swap in US dollars.</p>
          <div class="table-wrap">
            <table class="matrix">
              <caption class="visually-hidden">Kyro swap fee by swap value in US dollars</caption>
              <thead><tr><th scope="col">Swap value (USD)</th><th scope="col">Kyro fee</th></tr></thead>
              <tbody>
                <tr><th scope="row">$5 or less</th><td>5%</td></tr>
                <tr><th scope="row">$10</th><td>2%</td></tr>
                <tr><th scope="row">$25</th><td>1.8%</td></tr>
                <tr><th scope="row">$50</th><td>1.6%</td></tr>
                <tr><th scope="row">$80</th><td>1.4%</td></tr>
                <tr><th scope="row">$100</th><td>1.2%</td></tr>
                <tr><th scope="row">$1,000</th><td>0.9%</td></tr>
                <tr><th scope="row">$10,000 and above</th><td>0.7%</td></tr>
              </tbody>
            </table>
          </div>
          <p><strong>How it is calculated</strong> The table gives the rate at each listed value. Between two values the rate moves smoothly, interpolated on a logarithmic scale, so there are no sudden jumps.</p>
          <p><strong>Unknown token price</strong> If Kyro cannot find a price for the token, it cannot work out the swap value. The fee is then 0.9%.</p>
          <p><strong>Already included</strong> The fee is deducted from the amount you receive. Kyro shows only what you send and what you receive, so the “you receive” amount is what arrives, with no further Kyro charge.</p>
        </div>
      </div>
    </section>

    <section class="section seam" aria-labelledby="fee-example">
      <div class="wrap">
        <div class="head-center" data-reveal>
          <p class="eyebrow">Example</p>
          <h2 id="fee-example">A $200 swap</h2>
          <p>$200 falls between the $100 and $1,000 rows, so the rate is between 1.2% and 0.9%: about 1.11%.</p>
        </div>
        <div class="prose" data-reveal>
          <div class="receipt">
            <dl>
              <div><dt>You send</dt><dd class="num">200 USDC <small>≈ $200</small></dd></div>
              <div class="hl"><dt>Kyro fee, about 1.11%</dt><dd class="num">≈ $2.22 <small>already deducted</small></dd></div>
              <div><dt>You receive</dt><dd class="num">≈ $197.78 in the token you chose</dd></div>
              <div><dt>Network fee</dt><dd>Separate, paid to the network</dd></div>
            </dl>
          </div>
        </div>
      </div>
    </section>

    <section class="section seam" aria-labelledby="fee-how">
      <div class="wrap">
        <div class="prose" data-reveal>
          <h2 id="fee-how">How the swap fee works</h2>
          <ul class="checks">
            <li>The rate depends on the swap value, from 0.7% to 5%. It is already part of the quote: the amount you receive is after the fee.</li>
            <li>It is collected by each provider’s official integrator fee option. Kyro never adds a separate transfer to your transaction.</li>
            <li>Quotes are compared after fees: the best price shown already includes them.</li>
            <li>If a provider cannot apply the fee correctly, its quote is not shown.</li>
            <li>Providers may charge their own fee. It is already in the price they quote.</li>
          </ul>

          <h2 id="network-fees">Network fees</h2>
          <p>Every blockchain charges a fee to process a transaction. It goes to the network’s miners or validators, not to Kyro. Kyro estimates it and shows it before you confirm. On Ethereum layer 2s like Arbitrum, Optimism and Base it is usually a few cents; on Bitcoin and Ethereum it changes with demand.</p>

          <h2 id="why">Why a swap fee</h2>
          <p>The fee pays for development. Kyro is open source, so the fee is public: the schedule is set in the code, and anyone can build a version without it. Full details are in <a href="${REPO}/blob/main/docs/SWAP_FEES.md">SWAP_FEES.md</a>.</p>

          <div class="table-wrap">
            <table class="matrix">
              <caption class="visually-hidden">Kyro fees by action</caption>
              <thead><tr><th scope="col">Action</th><th scope="col">Kyro fee</th><th scope="col">Network fee</th></tr></thead>
              <tbody>
                <tr><th scope="row">Receive</th><td>0%</td><td>None</td></tr>
                <tr><th scope="row">Send</th><td>0%</td><td>Yes</td></tr>
                <tr><th scope="row">Stake, unstake</th><td>0%</td><td>Yes</td></tr>
                <tr><th scope="row">Swap</th><td>From 0.7%</td><td>Yes</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
    ${ctaPanel()}`;

  return { path, title, description, body, scripts: ['/download.js'], ld: webPage(path, 'Kyro Wallet fees', description, trail) };
}

export function download(chains) {
  const path = '/download/';
  const trail = [['/', 'Home'], [path, 'Download']];
  const title = `Download Kyro Wallet ${VERSION} for Windows, macOS and Linux`;
  const description = `Install Kyro Wallet ${VERSION} with one command on Windows, macOS or Linux, or download the .exe, .msi, .dmg, AppImage or .deb. How to check the SHA-256 checksum.`;

  const files = [
    [FILES.exe, 'Windows 64-bit', 'Installer, recommended'],
    [FILES.msi, 'Windows 64-bit', 'MSI package, for managed installs'],
    [FILES.dmg, 'macOS', 'Apple Silicon and Intel'],
    [FILES.appimage, 'Linux x86_64', 'Runs on most distributions'],
    [FILES.deb, 'Debian, Ubuntu', 'Package for apt'],
    [FILES.sums, 'All', 'SHA-256 checksums of every file']
  ];

  const body = html`
    ${pageHero({
      trail,
      eyebrow: `Version ${VERSION}`,
      h1: 'Download Kyro Wallet',
      lead: 'Free for Windows, macOS and Linux. Install it with one command, or download the file yourself. Kyro is published only on GitHub Releases.',
      extra: `<div class="actions" data-reveal><a class="btn btn-ghost btn-xl" href="${REPO}/releases/latest">Release notes</a></div>${usage()}`
    })}

    <section class="section section-tight" id="install" aria-labelledby="install-title">
      <div class="wrap">
        <div class="prose" data-reveal>
          <p class="eyebrow">Recommended</p>
          <h2 id="install-title">Install with one command</h2>
          <p>Paste the command for your system into PowerShell (Windows) or Terminal (macOS, Linux). It downloads the latest release from GitHub, checks its SHA-256 and installs it. A file fetched this way is not marked as downloaded from the internet, so Windows SmartScreen and macOS Gatekeeper do not block the first launch.</p>
          ${installBlock('dl')}
          <p class="small mute">On Windows the usual installer window opens. On macOS Kyro goes to Applications; on Linux to <code>~/.local/bin/kyro</code> with a menu entry. No administrator password is asked by the script.</p>
        </div>
      </div>
    </section>

    <section class="section section-tight seam" aria-labelledby="dl-files">
      <div class="wrap">
        <div class="prose" data-reveal>
          <p class="eyebrow">Or</p>
          <h2 id="dl-files">Download the file</h2>
        </div>
        <div data-reveal>${osCards()}</div>
        <div class="prose dl-files" data-reveal>
          <div class="faq dl-help" id="first-launch">
            <details>
              <summary>Downloaded the file in your browser?</summary>
              <div class="answer">
                <p>The installers are not code-signed yet, so Windows and macOS show a warning the first time you open a file downloaded by a browser. <a href="#verify">Verify the checksum</a> first, then:</p>
                <h3>Windows: “Windows protected your PC”</h3>
                <ol>
                  <li>Click <b>More info</b>.</li>
                  <li>Check that the file name is <code>${FILES.exe}</code>.</li>
                  <li>Click <b>Run anyway</b>.</li>
                </ol>
                <h3>macOS: “Kyro can’t be opened”</h3>
                <ol>
                  <li>Drag Kyro into Applications.</li>
                  <li>Right-click Kyro in Applications and choose <b>Open</b>, then <b>Open</b> again.</li>
                  <li>Or go to <b>System Settings › Privacy &amp; Security</b> and click <b>Open Anyway</b>.</li>
                </ol>
                <h3>Linux</h3>
                <pre><code>chmod +x ${FILES.appimage}
./${FILES.appimage}
# or
sudo apt install ./${FILES.deb}</code></pre>
                <p>The AppImage needs FUSE 2: <code>sudo apt install libfuse2t64</code> (Ubuntu 24.04 and later) or <code>libfuse2</code> (older releases).</p>
              </div>
            </details>
          </div>
          <p>For a hardware wallet over USB on Linux, install the <a href="https://github.com/LedgerHQ/udev-rules">Ledger</a> or <a href="https://trezor.io/learn/a/udev-rules">Trezor</a> udev rules.</p>
          <h2>All files</h2>
          <div class="table-wrap">
            <table class="matrix files">
              <caption class="visually-hidden">Kyro ${VERSION} release files</caption>
              <thead><tr><th scope="col">File</th><th scope="col">System</th><th scope="col">Notes</th></tr></thead>
              <tbody>
                ${files.map(([f, sys, note]) => `<tr><th scope="row"><a href="${DL}${f}">${f}</a></th><td>${sys}</td><td>${note}</td></tr>`)}
              </tbody>
            </table>
          </div>
          <p class="note note-warn"><b>Only from GitHub.</b> The files above come from <a href="${REPO}/releases">github.com/shuntraa/kyro-wallet/releases</a>. A copy offered anywhere else is not from us. Kyro has no mobile app: anything in an app store using the name is not ours.</p>
        </div>
      </div>
    </section>

    <section class="section seam" id="verify" aria-labelledby="verify-title">
      <div class="wrap">
        <div class="prose" data-reveal>
          <p class="eyebrow">Checksum</p>
          <h2 id="verify-title">Verify your download</h2>
          <p>The install commands do this for you. If you downloaded a file yourself, download <a href="${DL}${FILES.sums}">SHA256SUMS</a> next to it, compute the SHA-256 of your file and compare it with the matching line. If they differ, delete the file and download it again.</p>
          <h3>Windows (PowerShell)</h3>
          <pre><code>Get-FileHash .\\${FILES.exe} -Algorithm SHA256</code></pre>
          <h3>macOS (Terminal)</h3>
          <pre><code>shasum -a 256 ${FILES.dmg}</code></pre>
          <h3>Linux</h3>
          <pre><code>sha256sum -c SHA256SUMS --ignore-missing</code></pre>
        </div>
      </div>
    </section>

    <section class="section seam band" id="source" aria-labelledby="source-title">
      <div class="wrap">
        <div class="prose" data-reveal>
          <p class="eyebrow">Source</p>
          <h2 id="source-title">Build it yourself</h2>
          <p>You need Rust, Node.js 22+, pnpm 11 and the Tauri prerequisites. See the <a href="${REPO}#build-from-source">README</a>.</p>
          <pre><code>git clone https://github.com/shuntraa/kyro-wallet.git
cd kyro-wallet
pnpm install --frozen-lockfile
pnpm build</code></pre>
        </div>
      </div>
    </section>`;

  return {
    path,
    title,
    description,
    body,
    scripts: ['/download.js', '/copy.js', '/stats.js'],
    ld: [...webPage(path, 'Download Kyro Wallet', description, trail), appLd(chains)]
  };
}

const FAQ = [
  {
    title: 'The basics',
    items: [
      { home: true, q: 'Is Kyro Wallet free?', a: () => `<p>Yes. Kyro is free to download and use, and open source under GPL-3.0-or-later. Sending, receiving and staking cost only the network fee. Swaps from 0.7%, built into the rate. <a href="/fees/">Fee details</a>.</p>` },
      { home: true, q: 'Is Kyro custodial?', a: () => `<p>No. Kyro is non-custodial. Your keys are created and encrypted on your computer. There is no account and no server holding your funds, so nobody, including us, can freeze, move or recover them.</p>` },
      { q: 'Which blockchains does Kyro support?', a: (chains) => `<p>${chains.length} blockchains: ${listNames(chains.map((c) => c.name))}. Plus 220+ tokens on them. <a href="/chains/">What works on each one</a>.</p>` },
      { q: 'Which computers does Kyro run on?', a: () => `<p>Windows (64-bit), macOS (Apple Silicon and Intel) and Linux (x86_64 AppImage or .deb). <a href="/download/">Download</a>.</p>` },
      { q: 'Is there a mobile app?', a: () => `<p>No. Kyro is a desktop app only. An app in a mobile store using the Kyro name is not ours.</p>` }
    ]
  },
  {
    title: 'Swaps and staking',
    items: [
      { q: 'How much does a swap cost?', a: () => `<p>The Kyro fee depends on the value of the swap: 5% for $5 or less, down to 0.7% from $10,000, and 0.9% if the token price is unknown. It is already taken out of the amount you receive. The blockchain charges a separate network fee, which goes to the network. Providers may add their own fee, already included in their quote. <a href="/fees/">Full table</a>.</p>` },
      { q: 'Can I stake with Kyro?', a: () => `<p>Yes, on Solana, Cardano and TRON. You delegate from your own accounts; your coins never go to Kyro. Kyro takes no fee on staking. <a href="/features/#f-stake">How staking works</a>.</p>` }
    ]
  },
  {
    title: 'Security',
    items: [
      { home: true, q: 'Does Kyro support hardware wallets?', a: (chains) => `<p>Yes: Ledger and Trezor, including Trezor Safe 7. Supported on ${listNames(chains.filter((c) => c.features.hardware).map((c) => c.name))}.</p>` },
      { q: 'What happens if I lose my recovery phrase?', a: () => `<p>If you also lose your computer or password, your funds cannot be recovered. Kyro keeps no copy and cannot reset it. Write the phrase on paper, keep it offline, and never type it into a website.</p>` },
      { q: 'Can I import a recovery phrase from another wallet?', a: () => `<p>Yes. Kyro accepts standard 12 and 24-word BIP39 recovery phrases.</p>` },
      { q: 'Does Kyro use Tor?', a: () => `<p>Yes. Tor is built in and on by default, with a separate circuit per blockchain. If Tor fails, Kyro stops instead of connecting directly. You can also use your own servers.</p>` },
      { q: 'Does Kyro collect any data?', a: () => `<p>No personal data. No account, no analytics, no identifiers. Once a week, Kyro anonymously downloads a tiny file from its GitHub release over Tor, so GitHub’s download counter can estimate how many wallets are active; you can turn it off in Settings, Privacy. Every server the app contacts is listed in <a href="${REPO}/blob/main/docs/NETWORK.md">NETWORK.md</a>. This website sets no cookies; it only reads the public usage counters from GitHub.</p>` },
      { home: true, q: 'Is Kyro open source? Has it been audited?', a: () => `<p>The full source is on <a href="${REPO}">GitHub</a> under GPL-3.0-or-later. An internal security review has been done. No external audit has been published yet.</p>` },
      { q: 'How do I report a vulnerability?', a: () => `<p>Privately, through <a href="${REPO}/security">GitHub security advisories</a>. Please do not open a public issue. See the <a href="${REPO}/blob/main/SECURITY.md">security policy</a>.</p>` }
    ]
  },
  {
    title: 'Download and install',
    items: [
      { q: 'Where should I download Kyro?', a: () => `<p>Only from <a href="${REPO}/releases">GitHub Releases</a>, or from the links on <a href="/download/">kyrowallet.com/download</a>, which point there.</p>` },
      { q: 'How do I verify my download?', a: () => `<p>Compare the SHA-256 of your file with the matching line in <code>SHA256SUMS</code>.</p><pre><code>Get-FileHash .\\${FILES.exe} -Algorithm SHA256   # Windows
shasum -a 256 ${FILES.dmg}                                  # macOS
sha256sum -c SHA256SUMS --ignore-missing                      # Linux</code></pre>` },
      { q: 'Windows says “Windows protected your PC”. What do I do?', a: () => `<p>That is SmartScreen: the installer is not code-signed yet. Verify the checksum, then click <b>More info</b> and <b>Run anyway</b>. The <a href="/download/#install">one-line install command</a> checks the checksum for you and does not trigger this warning.</p>` },
      { q: 'macOS says Kyro can’t be opened. What do I do?', a: () => `<p>Right-click Kyro in Applications and choose <b>Open</b>, or go to <b>System Settings › Privacy &amp; Security</b> and click <b>Open Anyway</b>.</p>` }
    ]
  }
];

function faqItems(items, chains) {
  return items.map((i) => `<details><summary>${esc(i.q)}</summary><div class="answer">${i.a(chains)}</div></details>`).join('\n          ');
}

const strip = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .trim();

export function faq(chains) {
  const path = '/faq/';
  const trail = [['/', 'Home'], [path, 'FAQ']];
  const title = 'Kyro Wallet FAQ: fees, security, blockchains, install';
  const count = FAQ.reduce((n, g) => n + g.items.length, 0);
  const description = `Answers about Kyro Wallet: is it free, is it custodial, supported blockchains, swap fee, hardware wallets, recovery phrase, Tor, audits, and Windows or macOS warnings.`;

  const body = html`
    ${pageHero({
      trail,
      eyebrow: `${count} questions`,
      h1: 'Frequently asked questions',
      lead: `Can’t find yours? Ask on <a href="${REPO}/issues">GitHub</a>.`
    })}

    <section class="section section-tight" aria-label="Questions and answers">
      <div class="wrap">
        ${FAQ.map(
          (g, i) => html`
        <div class="faq" data-reveal>
          <h2 id="faq-${i + 1}">${g.title}</h2>
          ${faqItems(g.items, chains)}
        </div>`
        )}
      </div>
    </section>
    ${ctaPanel()}`;

  const ld = [
    ...webPage(path, 'Kyro Wallet FAQ', description, trail).slice(1),
    {
      '@type': 'FAQPage',
      '@id': `${SITE}${path}#page`,
      url: SITE + path,
      name: 'Kyro Wallet FAQ',
      isPartOf: { '@id': WEB_ID },
      mainEntity: FAQ.flatMap((g) => g.items).map((i) => ({
        '@type': 'Question',
        name: i.q,
        acceptedAnswer: { '@type': 'Answer', text: strip(i.a(chains)) }
      }))
    }
  ];
  return { path, title, description, body, scripts: ['/download.js'], ld };
}

const GROUPS = [
  ['Bitcoin and other UTXO coins', (c) => c.kind === 'utxo'],
  ['Ethereum and EVM chains', (c) => c.kind === 'evm'],
  ['Other networks', (c) => !['utxo', 'evm'].includes(c.kind)]
];

export function chainsIndex(chains) {
  const path = '/chains/';
  const trail = [['/', 'Home'], [path, 'Blockchains']];
  const title = `${chains.length} supported blockchains | Kyro Wallet`;
  const description = `Kyro Wallet supports ${chains.length} blockchains and 220+ tokens from one recovery phrase: ${listNames(chains.slice(0, 8).map((c) => c.name))} and more. See what works on each.`;

  const body = html`
    ${pageHero({
      trail,
      eyebrow: 'Blockchains',
      h1: `${chains.length} blockchains, one wallet`,
      lead: 'Every blockchain below works from the same recovery phrase. Pick one to see what you can do on it.'
    })}

    <section class="section section-tight" aria-label="Blockchains by type">
      <div class="wrap">
        ${GROUPS.map(([name, test], i) => {
          const list = chains.filter(test);
          if (!list.length) return '';
          return html`
        <div class="chain-group">
          <h2 id="group-${i + 1}" data-reveal>${name}</h2>
          <ul class="chain-grid" data-reveal-group>
          ${chainLinks(list)}
          </ul>
        </div>`;
        })}
      </div>
    </section>

    <section class="section seam" aria-labelledby="matrix-title">
      <div class="wrap wrap-narrow">
        <div class="head-center" data-reveal>
          <p class="eyebrow">Compare</p>
          <h2 id="matrix-title">What works where</h2>
          <p>Staking is available for SOL, ADA and TRX. Hardware wallets work on Bitcoin, Ethereum, the main EVM chains and Solana.</p>
        </div>
        ${matrix(chains)}
        <p class="center small mute">Missing a blockchain? <a href="${REPO}/issues">Ask on GitHub</a>.</p>
      </div>
    </section>
    ${ctaPanel()}`;

  const ld = [
    ...webPage(path, 'Blockchains supported by Kyro Wallet', description, trail),
    {
      '@type': 'ItemList',
      name: 'Blockchains supported by Kyro Wallet',
      numberOfItems: chains.length,
      itemListElement: chains.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, url: `${SITE}/chains/${c.slug}/` }))
    }
  ];
  return { path, title, description, body, scripts: ['/download.js'], ld };
}

const tokensPhrase = (c) => {
  if (!c.tokens) return '';
  return /tokens$|currencies$/.test(c.tokens) ? c.tokens : `${c.tokens} tokens`;
};

export function chainPage(c, chains) {
  const f = c.features;
  const path = `/chains/${c.slug}/`;
  const trail = [['/', 'Home'], ['/chains/', 'Blockchains'], [path, c.name]];
  const onL2 = c.ticker === 'ETH' && c.slug !== 'ethereum';
  const assets = (tokensPhrase(c) ? `${c.ticker} and ${tokensPhrase(c)}` : c.ticker) + (onL2 ? ` on ${c.name}` : '');
  const verbs = ['send', 'receive'];
  if (f.swap) verbs.push('swap');
  if (f.staking) verbs.push('stake');
  const verbText = listNames(verbs);
  const hwDev = (c.hwDevices || 'Ledger and Trezor').replace(' and ', ' or ');
  const capSentence = `${verbText[0].toUpperCase()}${verbText.slice(1)} ${assets}${f.hardware ? `, and sign with a ${hwDev}` : ''}.`;

  const title = `${c.name} wallet for Windows, macOS and Linux | Kyro`;
  const description = `Kyro is a free, open-source ${c.name} (${c.ticker}) wallet for desktop. ${capSentence} Your keys stay on your computer.`;

  const caps = [
    ['ic-send', 'Send and receive', f.send, `Send and receive ${assets}, with address-poisoning alerts and clipboard checks.`, `Not available on ${c.name} yet.`],
    ['ic-swap', 'Swap', f.swap, `${c.swapNote || `Swap ${c.ticker} in the app.`} The amount you receive already includes Kyro’s swap fee, from 0.7%.`, `Swaps are not available on ${c.name} yet.`],
    ['ic-stake', 'Staking', f.staking, `Stake ${c.ticker} from your own account. Kyro takes no fee on staking.`, `Kyro does not offer staking for ${c.ticker}.`],
    ['ic-hw', 'Hardware wallet', f.hardware, `Sign ${c.name} transactions with a ${hwDev}.${c.hwNote ? ' ' + c.hwNote : ''}`, `Not supported on ${c.name} yet. Use a software account.`]
  ];

  const visual = f.staking
    ? { solana: IMG.stakeSol, cardano: IMG.stakeAda, tron: IMG.stakeTrx }[c.slug] || IMG.assets
    : c.kind === 'evm'
      ? IMG.swap
      : IMG.assets;

  const related = [...chains.filter((o) => o.kind === c.kind && o.slug !== c.slug), ...chains.filter((o) => o.kind !== c.kind)].slice(0, 8);

  const body = html`
    ${pageHero({
      trail,
      before: `<div class="chain-mark" data-reveal>${coin(c, 'coin-lg')}</div>`,
      aside: `<div class="stage stage-chain" data-stage data-reveal>${win(visual.src, visual.alt, { w: visual.w, h: visual.h, title: `Kyro · ${c.name}`, cls: 'win-main' })}</div>`,
      eyebrow: `${esc(c.name)} · ${esc(c.ticker)}`,
      h1: `${esc(c.name)} wallet for Windows, macOS and Linux`,
      lead: `${capSentence} Kyro is free, open source and keeps your keys on your own computer.`,
      extra: `<div class="actions" data-reveal>${dlButton()}<a class="btn btn-ghost btn-xl" href="/chains/">All blockchains</a></div>`
    })}

    <section class="section section-tight" aria-labelledby="caps-title">
      <div class="wrap">
        <h2 id="caps-title" class="visually-hidden">What you can do on ${esc(c.name)}</h2>
        <ul class="caps" data-reveal-group>
          ${caps.map(
            ([icon, name, on, yes, no]) => html`
          <li class="cap spot ${on ? 'cap-on' : 'cap-off'}">
            <span class="mini-icon ${icon}" aria-hidden="true"></span>
            <h3>${name}</h3>
            <p>${on ? yes : no}</p>
            <span class="state">${on ? 'Yes' : 'No'}</span>
          </li>`
          )}
        </ul>
      </div>
    </section>

    <section class="section seam" aria-labelledby="on-chain">
      <div class="wrap feature-row">
        <div class="feature-text" data-reveal>
          <p class="eyebrow">Details</p>
          <h2 id="on-chain">${esc(c.name)} in Kyro</h2>
          ${c.staking ? `<p>${esc(c.staking)}</p>` : ''}
          <ul class="checks">
            ${(c.notes || []).map((n) => `<li>${esc(n)}</li>`)}
            <li>Same recovery phrase as your other ${chains.length - 1} blockchains.</li>
            <li>Keys encrypted on your computer; every signature confirmed in a system window.</li>
          </ul>
        </div>
        <div class="feature-visual" data-reveal>
          ${shot({ ...(visual === IMG.assets ? IMG.vault : IMG.assets), cls: 'frame-glow' })}
        </div>
      </div>
    </section>

    <section class="section seam band" aria-labelledby="related-title">
      <div class="wrap">
        <div class="head-center" data-reveal>
          <h2 id="related-title">Also in Kyro</h2>
          <p>Every blockchain lives in the same app, under the same recovery phrase.</p>
        </div>
        <ul class="chain-grid" data-reveal-group>
          ${chainLinks(related)}
        </ul>
        <p class="center"><a class="more" href="/chains/">All ${chains.length} blockchains</a></p>
      </div>
    </section>
    ${ctaPanel(`Get Kyro for ${esc(c.name)}`)}`;

  const ld = [
    ...webPage(path, `${c.name} wallet: Kyro`, description, trail)
  ];
  ld[0].about = [{ '@id': APP_ID }, { '@type': 'Thing', name: c.name, alternateName: c.ticker }];
  return { path, title, description, body, scripts: ['/download.js'], ld, chain: c };
}

export function notFound() {
  const body = html`
    <section class="notfound" aria-labelledby="page-title">
      <div class="aurora aurora-sm" aria-hidden="true"></div>
      <div class="wrap">
        <p class="eyebrow">404</p>
        <h1 id="page-title">Page not found</h1>
        <p>Kyro is only downloaded from the GitHub Releases page.</p>
        <div class="actions">
          <a class="btn btn-primary" href="/">Home</a>
          <a class="btn btn-ghost" href="/download/">Download</a>
        </div>
      </div>
    </section>`;
  return { path: '/404.html', title: 'Page not found | Kyro Wallet', description: 'This page does not exist on kyrowallet.com.', body, noindex: true, ld: [] };
}

// ------------------------------------------------------------------ privacy

export function privacy() {
  const path = '/privacy/';
  const trail = [['/', 'Home'], [path, 'Privacy']];
  const title = 'Privacy policy | Kyro Wallet';
  const description =
    'Kyro Wallet collects no personal data: no account, no analytics. A weekly anonymous count over Tor estimates active wallets and can be turned off. Network requests are listed in NETWORK.md.';

  const body = html`
    ${pageHero({
      trail,
      eyebrow: 'Privacy',
      h1: 'Privacy policy',
      lead: 'Kyro Wallet collects no personal data. There is no account and no analytics. Once a week, an anonymous download over Tor helps estimate how many wallets are active.'
    })}

    <section class="section section-tight" aria-label="Privacy policy">
      <div class="wrap">
        <div class="prose">
          <h2 id="collect">What Kyro collects</h2>
          <p>No personal data. The Kyro developers do not receive any personal data from the app: no crash reports, no identifiers, no addresses, no balances. Kyro has no user accounts and no sign-up.</p>

          <h2 id="weekly-count">Anonymous weekly count</h2>
          <p>Once a week, after you unlock Kyro and only over Tor, the app downloads a tiny file (<code>ping.txt</code>) from Kyro’s latest GitHub release. Nothing is sent with it: no identifier, no version, no address. GitHub’s public download counter for that file then gives an estimate of how many wallets are active each week; the only thing Kyro stores is the week it last did this. If Tor is off, it never happens. You can turn it off in Settings, Privacy, “Anonymous weekly count”.</p>

          <h2 id="device">Data on your device</h2>
          <p>Your recovery phrase and keys are encrypted with your password (Argon2id, then XChaCha20-Poly1305) and stored only on your computer. Settings, contacts and cached balances also stay on your computer. Nothing is backed up to a server or a cloud. Uninstalling Kyro and deleting its app folder removes this data; keep your recovery phrase on paper to restore your wallet.</p>

          <h2 id="network">Network requests</h2>
          <p>To show balances, prices and history, and to send transactions and swaps, Kyro contacts only the blockchain, price and swap providers listed in <a href="${REPO}/blob/main/docs/NETWORK.md">NETWORK.md</a>, which also says what each one sees. These requests go through the Tor network built into Kyro by default, so the providers do not see your IP address. They do see what you ask for: the public addresses you look up, the transactions you broadcast and, for swaps, the tokens, amounts and receiving address. Their own privacy policies apply to that data. You can use your own nodes and servers instead (Settings, Networks).</p>
          <p>The website kyrowallet.com sets no cookies and uses no trackers or analytics. To show its usage counters it reads one public file from <code>raw.githubusercontent.com</code>, without cookies or referrer.</p>

          <h2 id="contact">Contact</h2>
          <p>Questions about privacy: open an issue on <a href="${REPO}/issues">GitHub</a>. Security issues: report them privately through <a href="${REPO}/security">GitHub security advisories</a>.</p>
          <p>Last updated: 1 November 2026.</p>
        </div>
      </div>
    </section>`;

  return { path, title, description, body, ld: webPage(path, 'Kyro Wallet privacy policy', description, trail) };
}

// ------------------------------------------------------------------ code signing policy

export function codeSigningPolicy() {
  const path = '/code-signing-policy/';
  const trail = [['/', 'Home'], [path, 'Code signing policy']];
  const title = 'Code signing policy | Kyro Wallet';
  const description =
    'How Kyro Wallet release builds are code signed: free code signing by SignPath.io with a certificate by SignPath Foundation (pending approval), only for builds from the public GitHub Actions workflow.';

  const body = html`
    ${pageHero({
      trail,
      eyebrow: 'Code signing',
      h1: 'Code signing policy',
      lead: 'Free code signing provided by SignPath.io, certificate by SignPath Foundation.'
    })}

    <section class="section section-tight" aria-label="Code signing policy">
      <div class="wrap">
        <div class="prose">
          <h2 id="status">Status</h2>
          <p>Code signing through the SignPath Foundation program for open-source projects is planned and pending approval. <b>Until it is approved, Kyro releases are not code signed</b> (Windows SmartScreen shows a warning; see <a href="/download/#first-launch">First launch</a>). Automatic updates are signed separately with Kyro's update key and checked by the app. This page applies as soon as signing is active.</p>

          <h2 id="what">What is signed</h2>
          <p>Only release builds of Kyro Wallet built by the public GitHub Actions <a href="${REPO}/blob/main/.github/workflows/release.yml">release workflow</a> of <a href="${REPO}">github.com/shuntraa/kyro-wallet</a>, from a version tag, from the source code in that repository. Nothing built on a personal computer is signed, and the certificate is never used to sign anything else: no third-party software, no other project, no modified builds.</p>

          <h2 id="roles">Team roles</h2>
          <ul>
            <li>Committers and reviewers: <a href="https://github.com/shuntraa">shuntraa</a> (maintainer).</li>
            <li>Approvers (each signing request is approved by hand): <a href="https://github.com/shuntraa">shuntraa</a>.</li>
          </ul>
          <p>Every change to the repository goes through the maintainer.</p>

          <h2 id="privacy">Privacy</h2>
          <p>Kyro collects no personal data and transfers no information to other networked systems unless you ask for it: the blockchain, price and swap requests you trigger go to the providers listed in <a href="${REPO}/blob/main/docs/NETWORK.md">NETWORK.md</a>, over Tor by default. See the <a href="/privacy/">privacy policy</a>.</p>

          <h2 id="report">Report a problem</h2>
          <p>If you find a signed file that does not come from this project's release workflow, report it through <a href="${REPO}/security">GitHub security advisories</a>.</p>
        </div>
      </div>
    </section>`;

  return { path, title, description, body, ld: webPage(path, 'Kyro Wallet code signing policy', description, trail) };
}

export { FAQ };
