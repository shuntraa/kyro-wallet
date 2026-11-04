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
