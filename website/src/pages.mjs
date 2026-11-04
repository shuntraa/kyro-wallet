// SPDX-License-Identifier: GPL-3.0-or-later
// Content of every page on kyrowallet.com.

import { SITE, VERSION, REPO, DL, FILES, esc, html, a, coin, pageHero, dlButton, osCards, installBlock, ctaPanel, breadcrumbLd } from './layout.mjs';
import { strip, head, sec, row, ul, tbl, cards, faqBlock, faqLd, nextLinks, DONE, NEXT, routeOf, NO_SWAP, EARN_ON } from './kit.mjs';
import { appWindow, assetsCard, earnCard, confirmCard, vaultCard, ledgerScene, swapWidget, coinCard, coinHero, feeCalc, icon, term, circuits, phraseCard, privateCard, seesCards, moneroCard, roadList } from './components.mjs';

const layers = () => html`
        <div class="layers" data-reveal role="list" aria-label="Kyro's three layers">
          <div class="layer spot" role="listitem">
            <span class="layer-n">01</span>
            <div><b>Interface</b><span>Sandboxed web view. Never sees a key.</span></div>
          </div>
          <div class="layer spot" role="listitem">
            <span class="layer-n">02</span>
            <div><b>App shell</b><span>Tor, auto-lock, system confirmation window.</span></div>
          </div>
          <div class="layer layer-core spot" role="listitem">
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
  list.map((c) => `<li><a class="coin-tile spot c-${c.slug}" href="/chains/${c.slug}/">${coin(c)}<span class="chain-name">${esc(c.name)}<small>${esc(c.ticker)}</small></span></a></li>`).join('\n          ');

export const yesNo = (v) => (v ? '<span class="yes" role="img" aria-label="Yes"></span>' : '<span class="no" role="img" aria-label="No"></span>');

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

export const APP_ID = `${SITE}/#app`;
const ORG_ID = `${SITE}/#org`;
const WEB_ID = `${SITE}/#website`;

export function webPage(path, name, description, trail) {
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
      'Token swaps with a Kyro fee from 0.7%, included in the amount you receive with the provider’s own costs',
      'Earn: staking on Solana, Cardano, TRON, NEAR, Sui and Aptos, Lido and Aave',
      'Ledger and Trezor hardware wallets',
      'Several wallets on one device, and watch addresses with no key',
      'Local price and funds-received alerts',
      'Simulation before signing, fee speeds, speed up and cancel',
      'Built-in Tor, no personal data collected',
      'Transactions decoded and confirmed in a system window'
    ]
  };
}

/** Every blockchain on two slow rows of cards; the second copy of each row is what makes the loop seamless. */
function marquee(chains) {
  const half = Math.ceil(chains.length / 2);
  const row = (list, cls) => {
    const items = (hidden) =>
      list
        .map(
          (c) =>
            `<li${hidden ? ' aria-hidden="true"' : ''}><a class="coin-tile spot c-${c.slug}" href="/chains/${c.slug}/"${hidden ? ' tabindex="-1"' : ''}>${coin(c)}<span class="chain-name">${esc(c.name)}<small>${esc(c.ticker)}</small></span></a></li>`
        )
        .join('');
    return `<ul class="mq-row ${cls}">${items(false)}${items(true)}</ul>`;
  };
  return `<nav class="mq" aria-label="All supported blockchains">${row(chains.slice(0, half), 'mq-a')}${row(chains.slice(half), 'mq-b')}</nav>`;
}

const donateRows = [
  ['btc', 'Bitcoin', 'bc1qta8efdy72ge9qy8yj8s0ckwar0lg44ggwnaard', 'Bitcoin'],
  ['eth', 'Ethereum &amp; EVM', '0x86cD9af8067fF5e0001c709a550cD62b5e968B44', 'Ethereum and EVM'],
  ['sol', 'Solana', 'ptsbLdrhmEfC2eQ9gj4aieF4irdhQqYzK1fdNwHBZcM', 'Solana'],
  ['ltc', 'Litecoin', 'LWePW8iwa8RxxYB6av4KBriBNkRgLWvNyw', 'Litecoin'],
  ['doge', 'Dogecoin', 'DKCSjtypvD9qg3R175YdijmwvKh5FnAU14', 'Dogecoin'],
  ['trx', 'TRON', 'TT9j25bsbBAgxCDEXTN1cpjcD54Jz51pES', 'TRON'],
  ['ada', 'Cardano', 'addr1qy9d3jctafj2cgfm8sgllfjkrxrgxn9mz9dy0qzxuwscx6c2mr9sh6ny4ssnk0q3l7n9vxvxsdxtky26g7qydcapsd4sux3dj3', 'Cardano']
];

const donate = () => html`
          <details id="support">
            <summary>How can I support Kyro?</summary>
            <div class="answer">
              <p>Kyro is free. Donations keep it going. You can also <a href="https://github.com/sponsors/shuntraa">sponsor on GitHub</a>.</p>
              <div class="donate">
                <table class="stack">
                  <thead>
                    <tr><th scope="col">Network</th><th scope="col">Address</th><th scope="col"><span class="visually-hidden">Action</span></th></tr>
                  </thead>
                  <tbody>
                    ${donateRows.map(
                      ([id, name, addr, label]) => `<tr>
                      <th scope="row">${name}</th>
                      <td data-label="Address"><span class="address" id="addr-${id}">${addr}</span></td>
                      <td class="copy-cell"><button class="btn btn-ghost btn-sm" type="button" data-copy-target="addr-${id}" aria-label="Copy the ${label} address">Copy</button></td>
                    </tr>`
                    )}
                  </tbody>
                </table>
                <p class="copy-status" id="copy-status" role="status" aria-live="polite"></p>
              </div>
            </div>
          </details>`;

/** < 1000: exact. Then floored, one decimal under 10: 1.2k+, 12k+, 1.2M+, 7M+. */
function compact(n) {
  if (n < 1000) return String(n);
  const unit = n < 1e6 ? 'k' : 'M';
  const div = unit === 'k' ? 1e3 : 1e6;
  // Integer arithmetic first: 2300 / 1000 * 10 would floor to 22.
  const tenths = Math.floor((n * 10) / div);
  return String(tenths < 100 ? tenths / 10 : Math.floor(n / div)) + unit + '+';
}

let usageStats = {};
/** build.mjs hands over the counters before any page is rendered. */
export const setUsageStats = (s) => {
  usageStats = s || {};
};

/** Usage counters, baked in at build time so the site makes no outside request. Nothing shown without a value. */
const usage = () => {
  const item = (key, label, cls = '') => {
    const v = usageStats[key];
    return v > 0 ? `<span${cls}><strong data-roll>${compact(Math.floor(v))}</strong> ${label}</span>` : '';
  };
  const items = item('weekly_active', 'active wallets this week') + item('downloads_total', 'downloads in total', ' class="usage-total"');
  return items ? `<p class="usage">${items}</p>` : '';
};

export function home(chains) {
  const n = chains.length;
  const path = '/';
  const title = 'Kyro Wallet: open-source crypto wallet for Windows, macOS and Linux';
  const description = `Free, open-source, non-custodial wallet for Bitcoin, Ethereum, Solana and ${n - 3} more blockchains. Send, swap and stake. Your keys stay on your computer.`;
  const swapChains = chains.filter((c) => c.features.swap).length;
  const hwChains = chains.filter((c) => c.features.hardware).length;

  const hop = (mark, name, note) => `<li data-hop><span class="rt-dot">${mark}</span><b>${name}</b><small>${note}</small></li>`;

  const body = html`
    <section class="hero" id="showcase" aria-labelledby="hero-title">
      <div class="wrap hero-copy">
        <a class="badge" href="${REPO}">
          <span class="badge-tag"><i class="badge-dot" aria-hidden="true"></i>v${VERSION}</span>
          <span class="badge-text">Free and open source</span>
          <span class="badge-arrow" aria-hidden="true">→</span>
        </a>
        <h1 id="hero-title"><span class="ln"><span>Keep it</span></span> <span class="ln"><em>to yourself.</em></span></h1>
        <p class="lead hero-lead">A private crypto wallet for your desktop: ${n} blockchains, Tor on from the first launch, your keys on your own machine.</p>
        <div class="hero-cta">
          ${dlButton()}
          <a class="btn btn-ghost btn-xl" href="/download/" data-dl-other>Other platforms</a>
        </div>
        <div class="stats">
          <p><strong data-roll>${n}</strong> blockchains</p>
          ${usage()}
        </div>
      </div>
      <div class="hero-stage" data-story>
        <div class="kw-tilt"><div class="kw-wrap">${appWindow()}</div></div>
        <div class="kw-pick">
          <button type="button" class="on" data-go="0" aria-pressed="true">Portfolio</button>
          <button type="button" data-go="1" aria-pressed="false">Swap</button>
          <button type="button" data-go="2" aria-pressed="false">Earn</button>
        </div>
      </div>
    </section>

    <section class="section coins head-split" id="chains" aria-labelledby="chains-title">
      <div class="wrap">
        <div class="head-center">
          <p class="eyebrow" data-reveal>Blockchains</p>
          <h2 id="chains-title">${n} blockchains. <em>One phrase.</em></h2>
          <p data-reveal>Bitcoin to Zcash, plus 220+ tokens, from the same recovery phrase. No account, no email, nothing to sign up for.</p>
        </div>
      </div>
      ${marquee(chains)}
      <div class="wrap">
        <p><a class="more" href="/chains/">What works on each blockchain</a></p>
      </div>
    </section>

    <section class="section" id="how" aria-labelledby="how-title">
      <div class="wrap">
        ${head('How it works', 'how-title', 'Private in <em>three steps</em>', 'No account to open and nothing to configure. Tor is on before your first balance loads.')}
        <div class="steps3" data-reveal-group>
          <article class="step3 spot">
            <h3><span>1</span>Install</h3>
            <p>One command, or the installer. The script checks the SHA-256 before it runs anything.</p>
            ${term('PowerShell', ['$ irm https://kyrowallet.com/install.ps1 | iex', 'Checking SHA-256…', 'Installing Kyro…'])}
          </article>
          <article class="step3 spot">
            <h3><span>2</span>Create or import</h3>
            <p>Make a new phrase, bring your own 12 or 24 words, or plug in a Ledger or Trezor.</p>
            ${phraseCard()}
          </article>
          <article class="step3 spot">
            <h3><span>3</span>You’re private</h3>
            <p>Your keys are encrypted on your computer and your requests leave through Tor.</p>
            ${privateCard()}
          </article>
        </div>
        <p>${a('/guides/first-steps-with-kyro/', '<span class="more">First steps with Kyro</span>')}</p>
      </div>
    </section>

    <section class="section" id="tor" data-tor aria-labelledby="tor-title">
        <div class="wrap">
          <div class="head-center">
            <p class="eyebrow" data-reveal>Privacy</p>
            <h2 id="tor-title">Everything goes <em>through Tor</em></h2>
            <p data-reveal>Kyro is a Tor wallet from the first launch. Balances, prices, swaps and broadcasts leave through the built-in client, each blockchain gets its own circuit, and if Tor fails, Kyro stops.</p>
          </div>
          <div class="route spot" data-reveal>
            <div class="ip" aria-hidden="true">
              <span class="ip-label">The server sees</span>
              <code class="ip-val" data-ip>•••.•••.•••.•••</code>
              <span class="ip-note" data-ip-note>A Tor exit relay</span>
            </div>
            <div class="rt">
              <div class="rt-track"><i data-rt-fill></i></div>
              <ol class="rt-nodes">
                ${hop('<img src="/img/kyro-mark-dark.svg" width="22" height="22" alt="">', 'Kyro', 'Your computer')}
                ${hop('1', 'Relay 1', 'Sees your address, blind to the rest')}
                ${hop('2', 'Relay 2', 'Sees two other relays')}
                ${hop('3', 'Relay 3', 'Sees the request, never you')}
                ${hop(icon('assets'), 'Network', 'Sees a Tor exit')}
              </ol>
              <div class="rt-packet" data-packet aria-hidden="true"><i></i><i></i><i></i><b></b></div>
            </div>
          </div>
        </div>
    </section>

    <section class="section head-split" id="sees" aria-labelledby="sees-title">
      <div class="wrap">
        ${head('What servers see', 'sees-title', 'Your IP stays <em>out of the log</em>', 'A wallet has to ask servers about your addresses. The question is whether your IP address comes with it.')}
        <div data-reveal>${seesCards()}</div>
        <p class="tor-note">Tor hides who is asking, not what is asked: the server you query still sees those addresses. Run your own node to avoid that.</p>
        <p><a class="more" href="/tor/">How Kyro uses Tor</a></p>
      </div>
    </section>

    <section class="section head-split" id="fees" aria-labelledby="swap-title">
      <div class="wrap">
        <div class="head-center">
          <p class="eyebrow" data-reveal>Swap</p>
          <h2 id="swap-title">Any coin <em>to any coin</em></h2>
          <p data-reveal>Kyro asks several providers and shows what actually lands in your account, across ${swapChains} blockchains.</p>
        </div>
        <div class="swap-grid">
          <div class="glow-card swap-main spot g-ice" data-reveal>${swapWidget()}</div>
          <article class="glow-card spot g-deep" data-reveal>
            <img class="card-coin" src="/img/coins/xmr.svg" width="40" height="40" alt="" loading="lazy">
            <h3>Monero included</h3>
            <p>Swap in and out of XMR without leaving the wallet. Kyro is a full <a href="/chains/monero/">Monero desktop wallet</a> too.</p>
          </article>
          <article class="glow-card spot g-sky" data-reveal>
            <span class="card-num"><span data-roll>0.7</span><small>%</small></span>
            <h3>Fee in the rate</h3>
            <p>A Kyro fee from 0.7%, plus the provider’s own costs, all already out of the amount you receive. <a href="/fees/">Full swap fee table</a></p>
          </article>
        </div>
        <p><a class="more" href="/swap/">Routes, limits and checks</a></p>
      </div>
    </section>

    ${row('monero-title', 'Monero', 'Monero, <em>done properly</em>', false, html`
          <p>A full Monero desktop wallet with no light-wallet server. The node sends blocks and your machine scans them, so your view key never leaves it.</p>
          ${ul(['Your addresses and keys are never sent to the node.', 'Tor hides your IP from it. Your own node or a .onion works too.', 'A 25-word seed restores the wallet in Monero GUI, Feather or Cake Wallet.'])}
          <a class="more" href="/monero/">The private Monero wallet</a>`, moneroCard())}

    <section class="section" id="features" aria-labelledby="earn-title">
      <div class="wrap wrap-mid">
        <div class="head-center">
          <p class="eyebrow" data-reveal>Earn</p>
          <h2 id="earn-title">Earn <em>without an account</em></h2>
          <p data-reveal>Lido, Aave, Solana, Cardano, TRON, NEAR, Sui and Aptos in one list. No sign-up, and your keys stay with you.</p>
        </div>
        <div class="earn-wrap" data-reveal data-rows>${earnCard()}</div>
        <p class="center small mute">Demo numbers. Real rates are estimates, never guaranteed. From a hardware wallet: Lido, Aave, and staking on Solana, Cardano and NEAR.</p>
        <p class="center"><a class="more" href="/earn/">All 16 options and their risks</a></p>
      </div>
    </section>

    <section class="section hw-scene" data-ledger-track aria-labelledby="hw-title">
        <div class="wrap hw-grid">
          <div class="hw-text">
            <p class="eyebrow" data-reveal>Hardware wallets</p>
            <h2 id="hw-title">Ledger <em>and</em> Trezor</h2>
            <ol class="hw-steps" data-reveal>
              <li class="on"><span>1</span>Plug it in</li>
              <li class="on"><span>2</span>Click connect</li>
              <li class="on"><span>3</span>Confirm on the device</li>
            </ol>
            <p class="hw-count" data-reveal><strong data-ledger-n>${hwChains}</strong> blockchains, Trezor Safe 7 included.</p>
            <a class="more" href="/hardware-wallets/" data-reveal>Which device on which chain</a>
          </div>
          ${ledgerScene()}
        </div>
    </section>

    ${row('sign-title', 'Transaction review', 'Every signature, <em>decoded</em>', true, html`
          <p>The interface never gets the last word. The Rust core decodes the real transaction and a native system window shows it, drawn outside the web view. A compromised page cannot change what you read.</p>
          ${ul(['Amount, recipient, network and fee, as Rust read them.', 'Your password, then your click, for every signature.', 'Unusual transactions need a second, reinforced confirmation.', 'Address-poisoning alerts and clipboard checks before you send.'])}
          <a class="more" href="/security/">Nothing is signed without you</a>`, confirmCard())}

    <section class="section head-split" id="security" aria-labelledby="security-title">
      <div class="wrap">
        <div class="head-center">
          <p class="eyebrow" data-reveal>Security</p>
          <h2 id="security-title">Yours, <em>start to finish</em></h2>
          <p data-reveal>A non-custodial, open-source wallet. No account and no analytics. Only an anonymous weekly count over Tor, which you can turn off.</p>
        </div>
        <div class="bento bento-sec" data-reveal-group>
          <article class="glow-card spot g-ice tile-wide tile-show">
            <div>
            <span class="card-ic">${icon('lock')}</span>
            <h3>Keys stay on your device</h3>
            <p>Encrypted with your password and kept in the Rust core. No server has a copy.</p>
            </div>
            ${vaultCard()}
          </article>
          <article class="glow-card spot g-deep">
            <span class="card-ic">${icon('window')}</span>
            <h3>Native confirmation</h3>
            <p>Every signature opens a system window with the decoded amount, recipient and fee.</p>
          </article>
          <article class="glow-card spot g-sky">
            <span class="card-ic">${icon('code')}</span>
            <h3>Open source</h3>
            <p>GPL-3.0. Read the code, build it yourself, change it.</p>
          </article>
        </div>
        <p><a class="more" href="/security/">How Kyro protects your keys</a></p>
      </div>
    </section>

    <section class="section" id="compare" aria-labelledby="vs-title">
      <div class="wrap wrap-mid">
        ${head('Compare', 'vs-title', 'Kyro and <em>a typical wallet</em>', 'What to look for in a private crypto wallet, whichever one you pick.')}
        ${tbl('Kyro compared with a typical wallet', ['', 'Kyro', 'A typical wallet'], [
          ['Tor', 'Built in, on by default, stops if Tor fails', 'Direct connection'],
          ['Account', 'None', 'Varies, some ask for an email'],
          ['Analytics', 'None, one anonymous weekly count you can turn off', 'Varies'],
          ['Source code', 'Public, GPL-3.0-or-later', 'Varies'],
          ['Hardware wallets', `Ledger and Trezor, ${hwChains} blockchains`, 'Varies'],
          ['Swaps', 'Several providers compared, fee in the rate', 'Varies'],
          ['Signing', 'Decoded by Rust, shown in a system window', 'Usually shown inside the app']
        ], 'matrix vs')}
        <p class="tbl-note">“Typical” is a general description, not a test of any product. Check the wallet you use.</p>
      </div>
    </section>

    ${row('oss-title', 'Open source', 'Read the code. <em>All of it.</em>', false, html`
          <p>Kyro is an open source wallet under GPL-3.0-or-later: interface, Rust core and app shell, on <a href="${REPO}">GitHub</a>.</p>
          ${ul(['Dependencies pinned to exact versions, with committed lockfiles.', '<code>cargo audit</code>, <code>cargo deny</code> and <code>pnpm audit</code> in CI.', 'SHA256SUMS with every release, and signed automatic updates.', 'Every server Kyro contacts is listed in the repo.'])}
          <p class="small mute">Bit-for-bit reproducible builds are a goal, not a guarantee yet. The installers are not code-signed yet, so your system warns on first launch.</p>
          ${a('/open-source/', '<span class="more">Read, build and verify</span>')}`, term('Terminal', [`$ git clone ${REPO}.git`, '$ cd kyro-wallet', '$ pnpm install --frozen-lockfile', '$ pnpm build']))}

    <section class="section head-split" id="roadmap" aria-labelledby="road-title">
      <div class="wrap">
        ${head('Roadmap', 'road-title', 'Shipped, <em>and next</em>', `Version ${VERSION} today. No dates we cannot keep.`)}
        <div class="road-cols">
          <div><h3 class="road-h">Shipped</h3>${roadList(DONE.slice(3, 6), 'done')}</div>
          <div><h3 class="road-h">Next</h3>${roadList(NEXT.slice(0, 3), 'next')}</div>
        </div>
        <p>${a('/roadmap/', '<span class="more">The full roadmap</span>')}</p>
      </div>
    </section>

    <section class="section side-faq" aria-labelledby="faq-title">
      <div class="wrap">
        <div class="head-center">
          <p class="eyebrow" data-reveal>Questions</p>
          <h2 id="faq-title">Short <em>answers</em></h2>
        </div>
        <div class="faq" data-reveal>
          ${faqItems(FAQ.flatMap((g) => g.items).filter((i) => i.home), chains)}
          ${donate()}
        </div>
        <p><a class="more" href="/faq/">All questions</a></p>
      </div>
    </section>

    <section class="final" id="download" aria-labelledby="download-title">
      <div class="wrap">
        <h2 id="download-title">Your wallet, <em>your machine.</em></h2>
        <p class="dl-sub" data-reveal>Version ${VERSION} · Free · Windows, macOS and Linux</p>
        <div class="hero-cta" data-reveal>
          ${dlButton()}
          <a class="btn btn-ghost btn-xl" href="/download/" data-dl-other>Other platforms</a>
        </div>
      </div>
    </section>`;

  return {
    path,
    title,
    description,
    body,
    scripts: ['/download.js', '/copy.js', '/scenes.js'],
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
  const description = `What Kyro Wallet does: one portfolio for ${chains.length} blockchains, token swaps, staking and lending, Ledger and Trezor, built-in Tor and transactions you can read before you sign.`;
  const hw = chains.filter((c) => c.features.hardware).map((c) => c.name);

  const TABS = [['f-portfolio', 'Portfolio'], ['f-swap', 'Swap'], ['f-stake', 'Earn'], ['f-tor', 'Tor'], ['f-xmr', 'Monero'], ['f-sign', 'Transaction review'], ['f-hw', 'Hardware wallets']];
  const row = (id, label, h, flip, text, visual) => html`
    <div class="tab-panel${id === TABS[0][0] ? ' on' : ''}" id="p-${id}" role="tabpanel" aria-labelledby="t-${id}" tabindex="0">
      <div class="feature-row">
        <div class="feature-text">
          <p class="eyebrow">${label}</p>
          <h2 id="${id}">${h}</h2>
          <div>${text}</div>
        </div>
        <div class="feature-visual">${visual}</div>
      </div>
    </div>`;
  const tabBar = html`
        <div class="tab-list" role="tablist" aria-label="What Kyro does">
          ${TABS.map(([id, label], i) => `<button class="tab" type="button" role="tab" id="t-${id}" aria-controls="p-${id}" aria-selected="${i ? 'false' : 'true'}"${i ? ' tabindex="-1"' : ''}>${label}</button>`)}
        </div>`;
  const mini = (ic, g, h, p, i) => `<article class="glow-card spot ${g}${i ? ' tile-wide' : ''}"><span class="mini-icon ${ic}" aria-hidden="true"></span><h3>${h}</h3><p>${p}</p></article>`;

  const body = html`
    ${pageHero({
      trail,
      eyebrow: 'Features',
      h1: 'What Kyro <em>does</em>',
      lead: `A private crypto wallet: send, receive, swap and stake on ${chains.length} blockchains from one recovery phrase, over Tor, and read every transaction before it is signed.`
    })}
    <section class="section section-tight feature-tabs" aria-label="Features">
      <div class="wrap">
        ${tabBar}
    ${row('f-portfolio', 'Portfolio', 'All your coins <em>in one list</em>', false, html`
          <p>Total value, a price chart from one day to all time, and every asset with its balance, 7-day trend and share.</p>
          <ul class="checks">
            <li>Market tab with the top 200 coins, and favourites.</li>
            <li>Search assets and addresses with <kbd>Ctrl K</kbd>.</li>
            <li>Allocation by asset, and a vault panel with your security status.</li>
            <li>Several wallets on one device, each with its own phrase, password and history.</li>
            <li>Watch addresses: follow any public address or xpub with no key.</li>
            <li>Alerts for price levels and funds received, computed on your device.</li>
          </ul>`, assetsCard())}
    ${row('f-swap', 'Swap', 'The fee <em>in plain sight</em>', true, html`
          <p>Kyro asks several providers for a quote, including NEAR Intents across chains and Exolix for Monero, then picks the best price after fees. The Kyro fee, from 0.7%, and the provider’s own costs are already out of the amount you receive. <a href="/fees/">How it is calculated</a>.</p>
          <ul class="checks">
            <li>Token approvals are for the exact amount. Unlimited approvals are off unless you turn them on.</li>
            <li>The transaction is simulated just before you sign it.</li>
            <li>Maximum slippage of 0.1%, 0.5%, 1% or your own value.</li>
            <li>The provider’s transaction is decoded and checked: recipient, minimum amount and fee.</li>
          </ul>
          <p><a href="/swap/">Routes and limits</a></p>`, swapWidget())}
    ${row('f-stake', 'Earn', '16 ways <em>to earn</em>', false, html`
          <p>Stake, liquid-stake or lend from your own accounts, in one list. Rates are estimates, never guaranteed.</p>
          <ul class="checks">
            <li><b>Staking:</b> SOL, ADA, TRX, NEAR, SUI and APT. A validator, pool or Super Representative cannot spend your coins.</li>
            <li><b>Liquid staking:</b> ETH with Lido, with unstaking through Lido’s queue.</li>
            <li><b>Lending:</b> Aave v3 on Ethereum, Arbitrum, Polygon and Base.</li>
          </ul>
          <p class="small mute">Contract bugs, depegs and lower rewards are real risks. Staking works from Ledger and Trezor on Solana and Cardano, and from Ledger on NEAR; TRON, Sui and Aptos need a recovery-phrase account. <a href="/earn/">Options and risks</a></p>`, earnCard(['sol', 'ada', 'trx']))}
    ${row('f-tor', 'Tor', 'Tor, <em>on from the start</em>', true, html`
          <p>Every request leaves through a built-in Tor client, with separate circuits per blockchain family. If Tor is down, Kyro stops.</p>
          <p><a href="/tor/">What each party sees</a></p>`, circuits())}
    ${row('f-xmr', 'Monero', 'A real <em>Monero wallet</em>', false, html`
          <p>Blocks are scanned on your machine and your view key stays there. Swap in and out of XMR through Exolix.</p>
          <p><a href="/monero/">The private Monero wallet</a></p>`, moneroCard())}
    ${row('f-sign', 'Transaction review', 'Read it <em>before you sign it</em>', true, html`
          <p>The Rust core decodes each transaction and shows it in a native system window, outside the app’s web view.</p>
          <ul class="checks">
            <li>Contract calls, token approvals and high fees ask for a second confirmation.</li>
            <li>On Bitcoin: unknown scripts, OP_RETURN data and fees above 100 sat/vB too.</li>
            <li>Address-poisoning alerts and clipboard checks before you send.</li>
            <li>Simulation on swaps and Earn calls: what you send, receive and approve, and calls that would fail.</li>
            <li>Slow, Normal or Fast fees priced before you fill in the amount.</li>
            <li>Speed up or cancel a pending Bitcoin, Litecoin or EVM send.</li>
          </ul>`, confirmCard())}
    ${row('f-hw', 'Hardware wallets', 'Ledger <em>and</em> Trezor', false, html`
          <p>Keep your keys on a hardware wallet and use Kyro as the screen. Trezor Safe 7 pairs with a code.</p>
          <ul class="checks">
            <li>Supported on ${listNames(hw)}.</li>
            <li>Software accounts and hardware accounts side by side.</li>
          </ul>
          <p><a href="/hardware-wallets/">Device table and limits</a></p>`, ledgerScene())}
      </div>
    </section>

    <section class="section" aria-labelledby="f-more">
      <div class="wrap">
        <div class="head-center">
          <p class="eyebrow" data-reveal>And also</p>
          <h2 id="f-more">The <em>small things</em></h2>
        </div>
        <div class="bento bento-8" data-reveal-group>
          ${mini('ic-accounts', 'g-ice', 'Many accounts', 'Several accounts per blockchain from the same phrase. Move funds between them in two clicks.', true)}
          ${mini('ic-tor', 'g-deep', 'Tor built in', 'All traffic goes over Tor, with a separate circuit per blockchain. If Tor is down, Kyro does not fall back to a direct connection.')}
          ${mini('ic-eye', 'g-sky', 'No personal data', 'No account and no analytics. A weekly anonymous count over Tor, which you can turn off. Every server Kyro contacts is listed on GitHub.')}
          ${mini('ic-lock', 'g-deep', 'Auto-lock', 'The vault locks itself when the timer runs out, and on Windows as the computer goes to sleep. macOS and Linux lock on wake. Unlocking needs your password.')}
          ${mini('ic-send', 'g-sky', 'Your own servers', 'Point each blockchain at your own node or server. Kyro checks it is on the right network first.')}
          ${mini('ic-shield', 'g-deep', 'Approvals overview', 'The vault panel shows whether any unlimited token approval is active.')}
          ${mini('ic-swap', 'g-ice', `${chains.length} blockchains`, 'Bitcoin, Ethereum and EVM chains, Solana, TRON, Cardano, XRP Ledger and more. <a href="/chains/">See every blockchain</a>.')}
          ${mini('ic-stake', 'g-deep', 'Open source', 'GPL-3.0-or-later. Read the code, build it yourself, or change it.')}
        </div>
      </div>
    </section>
    ${nextLinks('f-next', [
      ['/swap/', 'Swap routes and limits', 'Every provider, and what does not swap yet.'],
      ['/hardware-wallets/', 'Ledger and Trezor', 'What works on which device.'],
      ['/guides/', 'Guides', 'Step-by-step articles, from backup to staking.']
    ], 'Go <em>deeper</em>')}
    ${ctaPanel()}`;

  return { path, title, description, body, scripts: ['/download.js', '/scenes.js'], ld: webPage(path, 'Kyro Wallet features', description, trail) };
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
      h1: 'How Kyro protects <em>your keys</em>',
      lead: 'Encrypted on your computer, confirmed in a system window. Here is what that covers, and what it does not.'
    })}

    <section class="section section-tight" aria-labelledby="s-layers">
      <div class="wrap split">
        <div class="split-text" data-reveal>
          <p class="eyebrow">Design</p>
          <h2 id="s-layers">Three layers, <em>one place for keys</em></h2>
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

    <section class="section" aria-labelledby="s-sign">
      <div class="wrap feature-row flip">
        <div class="feature-text" data-reveal>
          <p class="eyebrow">Before you sign</p>
          <h2 id="s-sign">Nothing is signed <em>without you</em></h2>
          <p>Every signature needs your password and a confirmation in a native system window, drawn by the app shell, outside the web view.</p>
          <ul class="checks">
            <li>The window shows the decoded transaction: amount, recipient, fee, account.</li>
            <li>Unusual transactions ask for a second confirmation: contract calls, any token approval, value sent to a contract, an unknown chain ID, high fees.</li>
            <li>Token approvals are for the exact amount by default.</li>
            <li>Address-poisoning alerts and clipboard checks before you send.</li>
          </ul>
        </div>
        <div class="feature-visual" data-reveal>
          ${confirmCard()}
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="s-net">
      <div class="wrap feature-row">
        <div class="feature-text" data-reveal>
          <p class="eyebrow">Network</p>
          <h2 id="s-net">Private <em>by default</em></h2>
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
          ${vaultCard()}
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="s-limits">
      <div class="wrap">
        <div class="prose" data-reveal>
          <p class="eyebrow">Limits</p>
          <h2 id="s-limits">What Kyro <em>cannot</em> protect you from</h2>
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
          <p>Please report security issues privately to <a href="mailto:security@kyrowallet.com">security@kyrowallet.com</a> or through <a href="${REPO}/security">GitHub security advisories</a>, not in a public issue. The <a href="${REPO}/blob/main/SECURITY.md">security policy</a> explains what is in scope and how reports are handled.</p>
        </div>
      </div>
    </section>
    ${sec('s-scams', html`
        ${head('Scams', 's-scams', 'Built against <em>the usual tricks</em>', 'Most losses start with a trick, so Kyro checks for the common ones before you sign.')}
        ${cards([
          ['Address poisoning', 'A blocking alert when a recipient looks like a known address without being it. The server’s history is never trusted. <a href="/guides/how-to-spot-address-poisoning/">How it works</a>', 'ic-eye'],
          ['Clipboard swaps', 'After you paste, Kyro watches the field, and shows the address in blocks. A swap before the paste can only be caught by comparing with your source.', 'ic-send'],
          ['Unlimited approvals', 'Approvals are exact by default. An unlimited one needs an explicit action and shows a warning.', 'ic-lock'],
          ['Booby-trapped text', 'Memos and token names from the chain are cleaned of line breaks, bidi and invisible characters before you read them.', 'ic-shield'],
          ['Booby-trapped updates', 'Each update is signed, and verified against a public key pinned in the app.', 'ic-swap'],
          ['Unknown servers', 'A new custom server is confirmed in a system window before any request goes out.', 'ic-tor']
        ])}`)}
    ${nextLinks('s-next', [
      ['/guides/back-up-your-recovery-phrase/', 'Back up your recovery phrase', 'The one thing Kyro cannot do for you.'],
      ['/tor/', 'How Kyro uses Tor', 'Who sees what, and what happens when Tor is down.'],
      ['/open-source/', 'Read, build and verify', 'Check the claims on this page yourself.']
    ])}
    ${ctaPanel()}`;

  return { path, title, description, body, scripts: ['/download.js'], ld: webPage(path, 'Kyro Wallet security', description, trail) };
}

export function fees(curve) {
  const path = '/fees/';
  const trail = [['/', 'Home'], [path, 'Fees']];
  const title = 'Fees: free to use, swaps from 0.7% | Kyro Wallet';
  const description =
    'Kyro Wallet is free. Sending, receiving and staking cost only the network fee. Swaps carry a Kyro fee from 0.7% to 5% depending on the swap value, plus the provider’s own costs, all already included in the quote.';

  const body = html`
    ${pageHero({
      trail,
      eyebrow: 'Fees',
      h1: 'Kyro is free. <em>Swaps from 0.7%.</em>',
      lead: 'Sending, receiving and staking cost only the network fee. Swaps carry a Kyro fee based on the swap value, plus the provider’s own costs. The quote you see already includes everything.'
    })}

    <section class="section section-tight" aria-label="Swap fee calculator">
      <div class="wrap wrap-mid">
        ${feeCalc(curve)}
      </div>
    </section>

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
            <span class="fee-desc">SOL, ADA, TRX, NEAR. Network fee only.</span>
          </div>
          <div class="fee-card fee-accent spot">
            <span class="fee-value"><span class="fee-from">from</span> <span data-roll>0.7%</span></span>
            <span class="fee-name">Kyro fee on swaps</span>
            <span class="fee-desc">Providers add their own costs. All included in the quote.</span>
          </div>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="fee-schedule">
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
          <p><strong>Already included</strong> The table is Kyro’s fee alone. Providers charge their own costs too. NEAR Intents takes an amount equal to Kyro’s fee on the routes it serves directly, so those swaps cost about double the Kyro rate (for example 0.8% + 0.8%). The “you receive” amount in the app already has all of this out, so it is what arrives, with nothing further to pay beyond the network fee.</p>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="fee-example">
      <div class="wrap">
        <div class="head-center" data-reveal>
          <p class="eyebrow">Example</p>
          <h2 id="fee-example">A <em>$200</em> swap</h2>
          <p>$200 falls between the $100 and $1,000 rows, so the rate is between 1.2% and 0.9%: about 1.11%.</p>
        </div>
        <div class="prose" data-reveal>
          <div class="receipt">
            <dl>
              <div><dt>You send</dt><dd class="num">200 USDC <small>≈ $200</small></dd></div>
              <div class="hl"><dt>Kyro fee, about 1.11%</dt><dd class="num">≈ $2.22 <small>already deducted</small></dd></div>
              <div><dt>After Kyro’s fee</dt><dd class="num">≈ $197.78 <small>before the provider’s costs</small></dd></div>
              <div><dt>Provider’s costs</dt><dd>Vary, already in the quote. On a route NEAR Intents serves directly: about 1.11% more, leaving ≈ $195.56</dd></div>
              <div><dt>Network fee</dt><dd>Separate, paid to the network</dd></div>
            </dl>
          </div>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="fee-how">
      <div class="wrap">
        <div class="prose" data-reveal>
          <h2 id="fee-how">How the swap fee works</h2>
          <ul class="checks">
            <li>The rate depends on the swap value, from 0.7% to 5%. It is already part of the quote.</li>
            <li>It is collected by each provider’s official integrator fee option. Exolix has none: on Exolix routes (Monero, Kaspa, Algorand and NEAR) the fee is a second transfer on the source chain.</li>
            <li>Quotes are compared after fees: the best price shown already includes them.</li>
            <li>If a provider cannot apply the fee correctly, its quote is not shown.</li>
            <li>Providers charge their own costs, on top of Kyro’s fee. NEAR Intents takes an amount equal to Kyro’s fee on the routes it serves directly, so those swaps cost about double the Kyro rate (for example 0.8% + 0.8%).</li>
            <li>The quote you see already includes everything. The Best price panel shows the provider, the Kyro rate and, when the quote gives it, the provider’s fee.</li>
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
    ${sec('fee-exolix', html`
        ${head('Exolix routes', 'fee-exolix', 'One route, <em>two transfers</em>', 'Monero, Kaspa, Algorand and NEAR go through Exolix, which has no integrator fee.')}
        ${cards([
          ['Same rate', 'The curve is the same as on every other route, taken from the amount you sell.', 'ic-swap'],
          ['Second transfer', 'The Kyro fee is a second ordinary transfer of the sold coin to Kyro’s fee address on that chain. It goes right after the deposit and carries its own network fee.', 'ic-send'],
          ['No separate transfer elsewhere', 'On other routes the fee is collected through the provider’s official integrator mechanism.', 'ic-shield']
        ])}`)}
    ${nextLinks('fee-next', [
      ['/swap/', 'Swap routes and limits', 'Which coin goes where, and through whom.'],
      ['/guides/swap-to-monero/', 'Swap to Monero', 'A worked example, step by step.'],
      ['/about/', 'How Kyro is paid for', 'Why there is a swap fee at all.']
    ])}
    ${ctaPanel()}`;

  return { path, title, description, body, scripts: ['/download.js', '/feecalc.js'], ld: webPage(path, 'Kyro Wallet fees', description, trail) };
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
      h1: 'Download <em>Kyro Wallet</em>',
      lead: 'Free for Windows, macOS and Linux. One command, or the file yourself. Kyro is published only on GitHub Releases.',
      extra: `<div class="hero-cta">${dlButton()}<a class="btn btn-ghost btn-xl" href="${REPO}/releases/latest">Release notes</a></div><div class="stats">${usage()}</div>`
    })}

    <section class="section section-tight" id="install" aria-labelledby="install-title">
      <div class="wrap">
        <div class="prose" data-reveal>
          <p class="eyebrow">Recommended</p>
          <h2 id="install-title">Install with <em>one command</em></h2>
          <p>Paste the command for your system into PowerShell (Windows) or Terminal (macOS, Linux). It downloads the latest release from GitHub, checks its SHA-256 and installs it. A file fetched this way is not marked as downloaded from the internet, so Windows SmartScreen and macOS Gatekeeper do not block the first launch.</p>
          ${installBlock('dl')}
          <p class="small mute">On Windows the usual installer window opens. On macOS Kyro goes to Applications; on Linux to <code>~/.local/bin/kyro</code> with a menu entry. No administrator password is asked by the script.</p>
        </div>
      </div>
    </section>

    <section class="section section-tight" aria-labelledby="dl-files">
      <div class="wrap">
        <div class="prose" data-reveal>
          <p class="eyebrow">Or</p>
          <h2 id="dl-files">Download <em>the file</em></h2>
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

    <section class="section" id="verify" aria-labelledby="verify-title">
      <div class="wrap">
        <div class="prose" data-reveal>
          <p class="eyebrow">Checksum</p>
          <h2 id="verify-title">Verify <em>your download</em></h2>
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

    <section class="section" id="source" aria-labelledby="source-title">
      <div class="wrap">
        <div class="prose" data-reveal>
          <p class="eyebrow">Source</p>
          <h2 id="source-title">Build it <em>yourself</em></h2>
          <p>You need Rust, Node.js 22+, pnpm 11 and the Tauri prerequisites. See the <a href="${REPO}#build-from-source">README</a>.</p>
          <pre><code>git clone https://github.com/shuntraa/kyro-wallet.git
cd kyro-wallet
pnpm install --frozen-lockfile
pnpm build</code></pre>
        </div>
      </div>
    </section>
    ${nextLinks('dl-next', [
      ['/wallets/windows/', 'Kyro for Windows', 'SmartScreen, .exe or .msi, and how updates work.'],
      ['/wallets/macos/', 'Kyro for macOS', 'Apple Silicon and Intel, and the first launch.'],
      ['/wallets/linux/', 'Kyro for Linux', 'AppImage or .deb, FUSE and udev rules.'],
      ['/guides/verify-your-download/', 'Verify your download', 'Check the SHA-256 in two minutes.'],
      ['/guides/windows-smartscreen/', 'What SmartScreen means', 'Why Windows warns, and what to do.'],
      ['/guides/first-steps-with-kyro/', 'First steps with Kyro', 'From install to your first small send.']
    ], 'After <em>the download</em>')}`;

  return {
    path,
    title,
    description,
    body,
    scripts: ['/download.js', '/copy.js'],
    ld: [...webPage(path, 'Download Kyro Wallet', description, trail), appLd(chains)]
  };
}

const FAQ = [
  {
    title: 'The basics',
    items: [
      { home: true, q: 'Is Kyro Wallet free?', a: () => `<p>Yes. Kyro is free to download and use, and open source under GPL-3.0-or-later. Sending, receiving and staking cost only the network fee. Swaps carry a Kyro fee from 0.7%, and providers add their own costs, all built into the quote. <a href="/fees/">Fee details</a>.</p>` },
      { home: true, q: 'Is Kyro custodial?', a: () => `<p>No. Kyro is non-custodial. Your keys are created and encrypted on your computer. There is no account and no server holding your funds, so nobody, including us, can freeze, move or recover them.</p>` },
      { home: true, q: 'Which blockchains does Kyro support?', a: (chains) => `<p>${chains.length} blockchains: ${listNames(chains.map((c) => c.name))}. Plus 220+ tokens on them. <a href="/chains/">What works on each one</a>.</p>` },
      { q: 'Which computers does Kyro run on?', a: () => `<p>Windows (64-bit), macOS (Apple Silicon and Intel) and Linux (x86_64 AppImage or .deb). <a href="/download/">Download</a>.</p>` },
      { home: true, q: 'Is there a mobile app?', a: () => `<p>No. Kyro is a desktop app only. An app in a mobile store using the Kyro name is not ours.</p>` }
    ]
  },
  {
    title: 'Swaps and staking',
    items: [
      { q: 'Can I swap Monero in Kyro?', a: () => `<p>Yes, both ways, through Exolix. Kyro’s fee is a second ordinary transfer of the coin you sell. <a href="/guides/swap-to-monero/">Swap to Monero</a>.</p>` },
      { q: 'Can I earn from a hardware wallet?', a: () => `<p>Lido and Aave work from Ledger and Trezor accounts. Staking works from Ledger and Trezor on Solana and Cardano, and from Ledger on NEAR; TRON, Sui and Aptos need a recovery-phrase account. <a href="/earn/">Options and risks</a>.</p>` },
      { home: true, q: 'How much does a swap cost?', a: () => `<p>The Kyro fee depends on the value of the swap: 5% for $5 or less, down to 0.7% from $10,000, and 0.9% if the token price is unknown. It is already taken out of the amount you receive. The blockchain charges a separate network fee, which goes to the network. Providers charge their own costs as well: NEAR Intents takes an amount equal to Kyro’s fee on the routes it serves directly, so those swaps cost about double the Kyro rate. The quote you see already includes everything. <a href="/fees/">Full fee table</a>.</p>` },
      { home: true, q: 'Can I stake with Kyro?', a: () => `<p>Yes. Earn lists 16 options: staking on Solana, Cardano, TRON, NEAR, Sui and Aptos, ETH liquid staking with Lido, and lending on Aave. Rates are estimates, never guaranteed. Kyro takes no fee on staking, and nothing here is financial advice. <a href="/earn/">Options and risks</a>.</p>` }
    ]
  },
  {
    title: 'Security',
    items: [
      { home: true, q: 'Does Kyro support hardware wallets?', a: (chains) => `<p>Yes: Ledger and Trezor, including Trezor Safe 7. Supported on ${listNames(chains.filter((c) => c.features.hardware).map((c) => c.name))}.</p>` },
      { home: true, q: 'What happens if I lose my recovery phrase?', a: () => `<p>If you also lose your computer or password, your funds cannot be recovered. Kyro keeps no copy and cannot reset it. Write the phrase on paper, keep it offline, and never type it into a website.</p>` },
      { home: true, q: 'Can I import a recovery phrase from another wallet?', a: () => `<p>Yes. Kyro accepts standard 12 and 24-word BIP39 recovery phrases.</p>` },
      { home: true, q: 'Does Kyro use Tor?', a: () => `<p>Yes. Tor is built in and on by default, with a separate circuit per blockchain. If Tor fails, Kyro stops instead of connecting directly. You can also use your own servers.</p>` },
      { home: true, q: 'Does Kyro collect any data?', a: () => `<p>No personal data. No account, no analytics, no identifiers. Once a week, Kyro anonymously downloads a tiny file from its GitHub release over Tor, so GitHub’s download counter can estimate how many wallets are active; you can turn it off in Settings, Privacy. Every server the app contacts is listed in <a href="${REPO}/blob/main/docs/NETWORK.md">NETWORK.md</a>. This website sets no cookies; it only reads the public usage counters from GitHub.</p>` },
      { home: true, q: 'Is Kyro open source? Has it been audited?', a: () => `<p>The full source is on <a href="${REPO}">GitHub</a> under GPL-3.0-or-later. An internal security review has been done. No external audit has been published yet.</p>` },
      { q: 'How do I report a vulnerability?', a: () => `<p>Privately, to <a href="mailto:security@kyrowallet.com">security@kyrowallet.com</a> or through <a href="${REPO}/security">GitHub security advisories</a>. Please do not open a public issue. See the <a href="${REPO}/blob/main/SECURITY.md">security policy</a>.</p>` }
    ]
  },
  {
    title: 'Download and install',
    items: [
      { q: 'Where should I download Kyro?', a: () => `<p>Only from <a href="${REPO}/releases">GitHub Releases</a>, or from the links on <a href="/download/">kyrowallet.com/download</a>, which point there.</p>` },
      { q: 'How do I verify my download?', a: () => `<p>Compare the SHA-256 of your file with the matching line in <code>SHA256SUMS</code>.</p><pre><code>Get-FileHash .\\${FILES.exe} -Algorithm SHA256   # Windows
shasum -a 256 ${FILES.dmg}                                  # macOS
sha256sum -c SHA256SUMS --ignore-missing                      # Linux</code></pre>` },
      { home: true, q: 'Windows says “Windows protected your PC”. What do I do?', a: () => `<p>That is SmartScreen: the installer is not code-signed yet. Verify the checksum, then click <b>More info</b> and <b>Run anyway</b>. The <a href="/download/#install">one-line install command</a> checks the checksum for you and does not trigger this warning.</p>` },
      { q: 'macOS says Kyro can’t be opened. What do I do?', a: () => `<p>Right-click Kyro in Applications and choose <b>Open</b>, or go to <b>System Settings › Privacy &amp; Security</b> and click <b>Open Anyway</b>.</p>` }
    ]
  }
];

export function faqItems(items, chains) {
  return items.map((i) => `<details><summary>${esc(i.q)}</summary><div class="answer">${i.a(chains)}</div></details>`).join('\n          ');
}

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
      h1: 'Frequently asked <em>questions</em>',
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
      h1: `${chains.length} blockchains, <em>one wallet</em>`,
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

    <section class="section" aria-labelledby="matrix-title">
      <div class="wrap wrap-narrow">
        <div class="head-center" data-reveal>
          <p class="eyebrow">Compare</p>
          <h2 id="matrix-title">What works <em>where</em></h2>
          <p>Staking is available for SOL, ADA, TRX, NEAR, SUI and APT. See <a href="/swap/">swap routes</a>, <a href="/earn/">Earn</a> and <a href="/hardware-wallets/">hardware wallets</a> for the details.</p>
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

function chainFaqs(c, ctx) {
  const { f, route, earnOn, devices, chains } = ctx;
  const hwNames = devices.replace(' and ', ' or ');
  const q = [
    [`Is Kyro a free ${c.name} wallet?`, `Yes. Kyro is free, open source and non-custodial. You pay the network fee when you send ${esc(c.ticker)}, and your keys stay on your own computer.`],
    [`Can I swap ${c.ticker} in Kyro?`, route ? `${route[1] === 'Yes' ? `Yes, ${route[2] === 'Yes' ? 'in both directions' : 'from it'}.` : 'You can swap into it, not out of it yet.'} Providers: ${route[3]}. <a href="/swap/">Routes and limits</a>.` : `Not yet. ${esc(NO_SWAP[c.slug] || '')}`],
    [f.staking ? `Can I stake ${c.ticker} in Kyro?` : `Can I earn on ${c.name} in Kyro?`, f.staking ? `Yes, from a recovery-phrase account${['solana', 'cardano', 'near'].includes(c.slug) ? ' or a hardware wallet' : ''}. ${esc(c.staking || '')} Rates are estimates, never guaranteed.` : earnOn ? `Yes: ${earnOn} Rates are estimates, never guaranteed, and contract risks apply. <a href="/earn/">Options and risks</a>.` : `Kyro offers no staking or lending on ${esc(c.name)}.`],
    [`Does Kyro work with a hardware wallet on ${c.name}?`, f.hardware ? `Yes, with a ${hwNames}.${c.hwNote ? ' ' + esc(c.hwNote) : ''} <a href="/hardware-wallets/">Device table</a>.` : `No. ${esc(c.name)} is not supported on hardware wallets in Kyro. Use a software account.`],
    [`What can a server see when I use ${c.name} in Kyro?`, c.slug === 'monero' ? 'The node sees the blocks you download and the transactions you publish, from a Tor exit relay. It never gets your addresses or your view key, because Kyro scans blocks locally. <a href="/monero/">Details</a>.' : `The server sees the addresses and transactions you ask about, and the IP of a Tor exit relay, not yours. ${esc(c.name)} has its own circuit family, except that all EVM networks share one. <a href="/tor/">Who sees what</a>.`],
    [`Can I use my existing recovery phrase for ${c.name}?`, `Yes, if it is a standard 12 or 24-word BIP39 phrase. It covers all ${chains.length} blockchains. <a href="/faq/">More questions</a>.`]
  ];
  return q;
}

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
  const devices = c.hwDevices || (f.hardware ? 'Ledger and Trezor' : '');
  const hwDev = devices.replace(' and ', ' or ');
  const route = routeOf(c.slug);
  const earnOn = EARN_ON[c.slug];
  const faqs = chainFaqs(c, { f, route, earnOn, devices, chains });
  const capSentence = `${verbText[0].toUpperCase()}${verbText.slice(1)} ${assets}${f.hardware ? `, and sign with a ${hwDev}` : ''}.`;

  const title = `${c.name} wallet for Windows, macOS and Linux | Kyro`;
  const description = `Kyro is a free, open-source ${c.name} (${c.ticker}) wallet for desktop. ${capSentence} Your keys stay on your computer.`;

  const caps = [
    ['ic-send', 'Send and receive', f.send, `Send and receive ${assets}, with address-poisoning alerts and clipboard checks.`, `Not available on ${c.name} yet.`],
    ['ic-swap', 'Swap', f.swap, `${c.swapNote || `Swap ${c.ticker} in the app.`} The amount you receive already includes Kyro’s swap fee, from 0.7%, and the provider’s own costs.`, `Swaps are not available on ${c.name} yet. ${NO_SWAP[c.slug] || ''}`],
    ['ic-stake', 'Earn', f.staking || !!earnOn, f.staking ? `Stake ${c.ticker} from your own account. Kyro takes no fee on staking. Rates are estimates.` : `${earnOn} Rates are estimates.`, `Kyro offers no staking or lending on ${c.name}.`],
    ['ic-hw', 'Hardware wallet', f.hardware, `Sign ${c.name} transactions with a ${hwDev}.${c.hwNote ? ' ' + c.hwNote : ''}`, `Not supported on ${c.name} yet. Use a software account.`]
  ];

  const related = [...chains.filter((o) => o.kind === c.kind && o.slug !== c.slug), ...chains.filter((o) => o.kind !== c.kind)].slice(0, 8);

  const body = html`
    ${pageHero({
      trail,
      aside: coinHero(c),
      eyebrow: `${esc(c.name)} desktop wallet · ${esc(c.ticker)}`,
      h1: `${esc(c.name)} wallet <em>for Windows, macOS and Linux</em>`,
      lead: `${capSentence} Kyro is free, open source and non-custodial: your keys stay on your own computer and traffic goes over Tor by default.`,
      extra: `<div class="hero-cta">${dlButton()}<a class="btn btn-ghost btn-xl" href="/chains/">All blockchains</a></div>`
    })}

    <section class="section section-tight" aria-labelledby="caps-title">
      <div class="wrap">
        <h2 id="caps-title" class="visually-hidden">What you can do on ${esc(c.name)}</h2>
        <ul class="caps" data-reveal-group>
          ${caps.map(
            ([icon, name, on, yes, no]) => html`
          <li class="cap spot c-${c.slug} ${on ? 'cap-on' : 'cap-off'}">
            <span class="mini-icon ${icon}" aria-hidden="true"></span>
            <h3>${name}</h3>
            <p>${on ? yes : no}</p>
            <span class="state">${on ? 'Yes' : 'No'}</span>
          </li>`
          )}
        </ul>
      </div>
    </section>

    <section class="section" aria-labelledby="on-chain">
      <div class="wrap feature-row">
        <div class="feature-text">
          <p class="eyebrow" data-reveal>Details</p>
          <h2 id="on-chain">${esc(c.name)} <em>in Kyro</em></h2>
          ${c.staking ? `<p data-reveal>${esc(c.staking)}</p>` : ''}
          <ul class="checks" data-reveal>
            ${(c.notes || []).map((n) => `<li>${esc(n)}</li>`)}
            <li>Same recovery phrase as your other ${chains.length - 1} blockchains.</li>
            <li>Keys encrypted on your computer; every signature confirmed in a system window.</li>
          </ul>
          <div class="doc-links" data-reveal>
            <a href="/features/">All wallet features</a>
            ${f.swap ? '<a href="/fees/">How swap fees work</a>' : ''}
            <a href="/security/">How your keys are protected</a>
          </div>
        </div>
        <div class="feature-visual" data-reveal>${coinCard(c)}</div>
      </div>
    </section>

    ${sec('at-glance', html`
        ${head('At a glance', 'at-glance', `${esc(c.name)} <em>in one table</em>`, 'What works today, and through what.')}
        ${tbl(`What Kyro supports on ${c.name}`, ['', 'Available', 'Details'], [
          ['Send and receive', yesNo(f.send), `${esc(assets)}. Over Tor, with address-poisoning alerts.`],
          ['Swap from', yesNo(route && route[1] === 'Yes'), route ? `Providers: ${route[3]}.` : esc(NO_SWAP[c.slug] || '')],
          ['Swap to', yesNo(route && route[2] === 'Yes'), route ? 'The amount you see already has Kyro’s fee out.' : 'No route yet.'],
          ['Earn', yesNo(f.staking || earnOn), f.staking ? `Staking from your own account, with a recovery-phrase account only. Rates are estimates.` : earnOn || 'Not offered.'],
          ['Ledger', yesNo(f.hardware && devices.includes('Ledger')), f.hardware && devices.includes('Ledger') ? 'Keys stay in the device.' : 'Not supported.'],
          ['Trezor', yesNo(f.hardware && devices.includes('Trezor')), f.hardware && devices.includes('Trezor') ? 'Keys stay in the device.' : 'Not supported.']
        ])}
        <div class="doc-links" data-reveal>
          ${f.swap ? '<a href="/swap/">Swap routes and limits</a>' : ''}
          ${f.staking || earnOn ? '<a href="/earn/">Earn options and risks</a>' : ''}
          ${f.hardware ? '<a href="/hardware-wallets/">Ledger and Trezor in Kyro</a>' : ''}
          <a href="/tor/">How Kyro uses Tor</a>
        </div>`)}
    ${faqBlock('chain-faq', faqs, `${esc(c.name)} <em>questions</em>`)}

    <section class="section" aria-labelledby="related-title">
      <div class="wrap">
        <div class="head-center" data-reveal>
          <h2 id="related-title">Also <em>in Kyro</em></h2>
          <p>Same app, same recovery phrase.</p>
        </div>
        <ul class="chain-grid" data-reveal-group>
          ${chainLinks(related)}
        </ul>
        <p><a class="more" href="/chains/">All ${chains.length} blockchains</a></p>
      </div>
    </section>
    ${ctaPanel(`Get Kyro <em>for ${esc(c.name)}</em>`)}`;

  const ld = [
    ...webPage(path, `${c.name} wallet: Kyro`, description, trail)
  ];
  ld[0].about = [{ '@id': APP_ID }, { '@type': 'Thing', name: c.name, alternateName: c.ticker }];
  ld.push(faqLd(SITE + path, faqs));
  return { path, title, description, body, scripts: ['/download.js'], ld, chain: c };
}

export function notFound() {
  const body = html`
    <section class="notfound" aria-labelledby="page-title">
      <div class="wrap">
        <p class="notfound-n" aria-hidden="true">404</p>
        <h1 id="page-title">Page <em>not found</em></h1>
        <p>Kyro is only downloaded from the GitHub Releases page.</p>
        <div class="hero-cta">
          <a class="btn btn-primary btn-xl" href="/">Home</a>
          <a class="btn btn-ghost btn-xl" href="/download/">Download</a>
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
      h1: 'Privacy <em>policy</em>',
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
          <p>The website kyrowallet.com sets no cookies, uses no trackers or analytics and makes no third-party request. Everything it loads comes from the site itself, and its usage counters are written into the pages when the site is built.</p>

          <h2 id="contact">Contact</h2>
          <p>Questions about privacy: <a href="mailto:contact@kyrowallet.com">contact@kyrowallet.com</a>. Help with the app: <a href="mailto:support@kyrowallet.com">support@kyrowallet.com</a>. Security issues: <a href="mailto:security@kyrowallet.com">security@kyrowallet.com</a>.</p>
          <p>Last updated: 4 November 2026.</p>
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
      h1: 'Code signing <em>policy</em>',
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
          <p>If you find a signed file that does not come from this project's release workflow, report it to <a href="mailto:security@kyrowallet.com">security@kyrowallet.com</a> or through <a href="${REPO}/security">GitHub security advisories</a>.</p>
        </div>
      </div>
    </section>`;

  return { path, title, description, body, ld: webPage(path, 'Kyro Wallet code signing policy', description, trail) };
}

export { FAQ };
