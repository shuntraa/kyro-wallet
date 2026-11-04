// SPDX-License-Identifier: GPL-3.0-or-later
// Small building blocks shared by every page: section heads, feature rows, card grids, FAQs.

import { html, esc, a } from './layout.mjs';

export const strip = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .trim();

/** Centered section head. */
export const head = (eyebrow, id, h2, p = '') => html`
        <div class="head-center">
          ${eyebrow ? `<p class="eyebrow" data-reveal>${eyebrow}</p>` : ''}
          <h2 id="${id}">${h2}</h2>
          ${p ? `<p data-reveal>${p}</p>` : ''}
        </div>`;

/** A section with the usual wrapper. */
export const sec = (id, inner, cls = '', wrap = 'wrap') => html`
    <section class="section${cls ? ' ' + cls : ''}" aria-labelledby="${id}">
      <div class="${wrap}">${inner}</div>
    </section>`;

/** Text on one side, a replica on the other. */
export const row = (id, label, h, flip, text, visual) => html`
    <section class="section" aria-labelledby="${id}">
      <div class="wrap feature-row${flip ? ' flip' : ''}">
        <div class="feature-text">
          <p class="eyebrow" data-reveal>${label}</p>
          <h2 id="${id}">${h}</h2>
          <div data-reveal>${text}</div>
        </div>
        <div class="feature-visual" data-reveal>${visual}</div>
      </div>
    </section>`;

const GLOWS = ['g-ice', 'g-deep', 'g-sky'];
/** Grid of cards: [title, text, optional mini-icon class]. */
export const cards = (list, four = false) => html`
        <div class="glow-grid${four ? ' glow-grid-4' : ''}" data-reveal-group>
          ${list.map(
            ([h, p, ic], i) => `<article class="glow-card spot ${GLOWS[i % 3]}">${ic ? `<span class="mini-icon ${ic}" aria-hidden="true"></span>` : ''}<h3>${h}</h3><p>${p}</p></article>`
          )}
        </div>`;

/** Questions: [question, answer HTML]. */
export const faqBlock = (id, items, h2 = 'Common <em>questions</em>') =>
  sec(
    id,
    html`
        ${head('Questions', id, h2)}
        <div class="faq" data-reveal>
          ${items.map(([q, ans]) => `<details><summary>${esc(q)}</summary><div class="answer"><p>${ans}</p></div></details>`)}
        </div>`
  );

export const faqLd = (url, items) => ({
  '@type': 'FAQPage',
  '@id': `${url}#faq`,
  url,
  mainEntity: items.map(([q, ans]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: strip(ans) } }))
});

/** "Keep reading" cards, each with a descriptive link: [path, title, text]. */
export const nextLinks = (id, list, h2 = 'Keep <em>reading</em>') =>
  sec(
    id,
    html`
        ${head('', id, h2)}
        <ul class="link-cards" data-reveal-group>
          ${list.map(([href, t, p]) => `<li class="glow-card spot"><h3>${a(href, t)}</h3><p>${p}</p></li>`)}
        </ul>`
  );

/** The roadmap, shown on /roadmap/ and on the home page. */
export const DONE = [
  ['36 blockchains, one phrase', 'Bitcoin, EVM networks, Solana, TRON, Cardano, Monero and more, with 220+ tokens.'],
  ['Tor built in', 'On by default, a circuit per blockchain family, no fallback to a direct connection.'],
  ['Signed automatic updates', 'Downloaded over Tor, verified against a pinned public key, applied at the next start.'],
  ['Swaps across chains', 'Several providers compared, with Monero, Kaspa, Algorand and NEAR both ways through Exolix since 1.0.6.'],
  ['Earn', '14 options since 1.0.5: Lido, Aave v3, and staking on Solana, Cardano, TRON and NEAR.'],
  ['Hardware wallets', 'Ledger and Trezor, one-step Ledger connect, SPL and TRC-20 token sends in 1.0.6.'],
  ['One-click Windows installer', 'A single branded window since 1.0.1, and one-line install on every system.']
];
export const NEXT = [
  ['More staking', 'Polkadot, Sui and Aptos.'],
  ['Token sends on more chains', 'From hardware accounts, beyond EVM, Solana and TRON.'],
  ['Code signing', 'So Windows and macOS stop warning on first launch. See the <a href="/code-signing-policy/">code signing policy</a>.'],
  ['winget', 'Install and update with the Windows package manager.'],
  ['More Ledger chains', 'Polkadot, Kaspa and Zcash on Ledger, where the device apps make it possible.'],
  ['Compact filters for Bitcoin', 'A private way to read Bitcoin without an address server, once its dependencies pass review.'],
  ['Reproducible builds', 'Bit-for-bit reproducible builds are a goal, not yet a guarantee.']
];

export const ul = (items, cls = 'checks') => `<ul class="${cls}">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

export const tbl = (caption, heads, rows, cls = 'matrix') => html`
        <div class="table-wrap" data-reveal>
          <table class="${cls}">
            <caption class="visually-hidden">${caption}</caption>
            <thead><tr>${heads.map((h) => `<th scope="col">${h}</th>`)}</tr></thead>
            <tbody>
              ${rows.map(([first, ...rest]) => `<tr><th scope="row">${first}</th>${rest.map((c) => `<td>${c}</td>`).join('')}</tr>`)}
            </tbody>
          </table>
        </div>`;
