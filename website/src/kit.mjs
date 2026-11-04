// SPDX-License-Identifier: GPL-3.0-or-later
// Small building blocks shared by every page: section heads, feature rows, card grids, FAQs.

import { html, esc, a } from './layout.mjs';

export const strip = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
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
// The shape follows the content: three things share one panel, six make a bento, and `rows` is a plain
// two-column list for what should be read slowly, such as risks and limits.
const shapeOf = (n, rows) => (rows ? 'rows' : n === 3 ? 'tiles tiles-3' : n === 4 ? 'tiles tiles-2' : 'bento bento-z');
const wide = (i, shape) => (shape === 'bento bento-z' && (i === 0 || i === 3) ? ' tile-wide' : '');
/** Cards: [title, text, optional mini-icon class]. */
export const cards = (list, rows = false) => {
  const shape = shapeOf(list.length, rows);
  return html`
        <div class="${shape}" data-reveal-group>
          ${list.map(
            ([h, p, ic], i) => `<article class="glow-card spot ${GLOWS[i % 3]}${wide(i, shape)}">${ic ? `<span class="mini-icon ${ic}" aria-hidden="true"></span>` : ''}<h3>${h}</h3><p>${p}</p></article>`
          )}
        </div>`;
};

/** Questions: [question, answer HTML]. */
export const faqBlock = (id, items, h2 = 'Common <em>questions</em>') =>
  sec(
    id,
    html`
        ${head('Questions', id, h2)}
        <div class="faq" data-reveal>
          ${items.map(([q, ans]) => `<details><summary>${esc(q)}</summary><div class="answer"><p>${ans}</p></div></details>`)}
        </div>`,
    'side-faq'
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
          ${list.map(([href, t, p]) => `<li class="spot"><h3>${a(href, t)}</h3><p>${p}</p></li>`)}
        </ul>`
  );

/** The roadmap, shown on /roadmap/ and on the home page. */
export const DONE = [
  ['36 blockchains, one phrase', 'Bitcoin, EVM networks, Solana, TRON, Cardano, Monero and more, with 220+ tokens.'],
  ['Tor built in', 'On by default, a circuit per blockchain family, no fallback to a direct connection.'],
  ['Signed automatic updates', 'Downloaded over Tor, verified against a pinned public key, applied at the next start.'],
  ['Swaps across chains', 'Several providers compared, with Monero, Kaspa, Algorand and NEAR both ways through Exolix since 1.0.6.'],
  ['Earn', '16 options: Lido, Aave v3, and staking on Solana, Cardano, TRON, NEAR, Sui and Aptos.'],
  ['Hardware wallets', 'Ledger and Trezor, one-step Ledger connect, token sends on Solana, TRON, TON, Stellar, Sui, Aptos, Algorand and NEAR.'],
  ['Staking from hardware wallets', 'Solana and Cardano on Ledger and Trezor, NEAR on Ledger.'],
  ['Several wallets', 'More than one recovery phrase on a device, each with its own password, accounts and history.'],
  ['Watch addresses', 'Follow any public address or xpub with no key.'],
  ['Alerts', 'Price levels and funds received, as system notifications computed on your device.'],
  ['Simulation before signing', 'On swaps and Earn calls: what you send and receive, what you approve, and calls that would fail.'],
  ['Fee choice, speed up and cancel', 'Slow, Normal or Fast on Send, and pending Bitcoin, Litecoin or EVM sends can be sped up or cancelled.'],
  ['Recovery phrase passphrase', 'The optional BIP39 25th word, on every chain. If you forget it, those funds are lost.'],
  ['Dust protection', 'Tiny coins from strangers stay out of your sends on Bitcoin, Litecoin, Dogecoin, Bitcoin Cash, Dash and Zcash.'],
  ['ENS names on Send', 'Type name.eth on EVM chains. The review shows the real address. Names stored off-chain are not read.'],
  ['Tor bridges', 'Plain bridge lines for places that block Tor. obfs4 and other disguised bridges are not supported yet.'],
  ['Lock before sleep', 'On Windows, Kyro locks as the computer goes to sleep. macOS and Linux lock on wake.'],
  ['Tokens you receive', 'Other Sui coins, Cosmos Hub tokens and CashTokens show read only. Kyro cannot send them yet.'],
  ['One-click Windows installer', 'A single branded window since 1.0.1, and one-line install on every system.']
];
export const NEXT = [
  ['Polkadot staking', 'The next Earn option.'],
  ['Code signing', 'So Windows and macOS stop warning on first launch. See the <a href="/code-signing-policy/">code signing policy</a>.'],
  ['winget', 'Install and update with the Windows package manager.'],
  ['More Ledger chains', 'Polkadot, Kaspa and Zcash on Ledger, where the device apps make it possible.'],
  ['Compact filters for Bitcoin', 'A private way to read Bitcoin without an address server, once its dependencies pass review.'],
  ['Reproducible builds', 'Bit-for-bit reproducible builds are a goal, not yet a guarantee.'],
  ['Lightning payments', 'Later. Paying an invoice from a Bitcoin account, once a real payment and a real refund have been run.']
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

export const ROUTES = [
  ['Ethereum, Arbitrum, Optimism, Base', 'Yes', 'Yes', '0x and LI.FI on the same chain. 1Click and LI.FI across chains. Exolix to XMR, KAS, ALGO and NEAR'],
  ['Polygon', 'Yes', 'Yes', '0x and LI.FI. 1Click. Exolix to XMR, KAS, ALGO and NEAR'],
  ['BNB Chain, Avalanche', 'Yes', 'Yes', '0x and LI.FI. 1Click'],
  ['Gnosis', 'Yes', 'Yes', 'LI.FI. 1Click'],
  ['Cronos, Mantle, Sonic, Flare, Kaia, HyperEVM, Sei', 'Yes', 'Yes', '0x or LI.FI, same chain only'],
  ['Solana and SPL tokens', 'Yes', 'Yes', 'Jupiter on Solana. LI.FI and 1Click across chains. Exolix for SOL, USDT and USDC'],
  ['Bitcoin', 'Yes', 'Yes', '1Click, LI.FI. Exolix to XMR, KAS, ALGO and NEAR'],
  ['Litecoin, Dogecoin, TRON (TRX, USDT)', 'Yes', 'Yes', '1Click. Exolix'],
  ['XRP, Cardano, Bitcoin Cash, Dash, Zcash, Sui, TON, Aptos', 'Yes', 'Yes', '1Click'],
  ['Stellar', 'No', 'Yes', '1Click, arrival only: a Stellar deposit needs a memo'],
  ['Monero, Kaspa, Algorand, NEAR (native coin)', 'Yes', 'Yes', 'Exolix. Kyro’s fee is a second transfer']
];

/** Row of ROUTES for each blockchain. */
export const ROUTE_SLUGS = [
  ['ethereum', 'arbitrum', 'optimism', 'base'],
  ['polygon'],
  ['bnb-chain', 'avalanche'],
  ['gnosis'],
  ['cronos', 'mantle', 'sonic', 'flare', 'kaia', 'hyperevm', 'sei'],
  ['solana'],
  ['bitcoin'],
  ['litecoin', 'dogecoin', 'tron'],
  ['xrp', 'cardano', 'bitcoin-cash', 'dash', 'zcash', 'sui', 'ton', 'aptos'],
  ['stellar'],
  ['monero', 'kaspa', 'algorand', 'near']
];
export const routeOf = (slug) => ROUTES[ROUTE_SLUGS.findIndex((r) => r.includes(slug))];

export const NO_SWAP = {
  polkadot: '1Click does not list Polkadot, and delivery to Asset Hub is not confirmed through Exolix.',
  cosmos: '1Click does not list Cosmos Hub, and Exolix refuses the pair.',
  conflux: 'There is no provider contract Kyro can check on Conflux yet.'
};

/** Earn options on chains without native staking in Kyro. */
export const EARN_ON = {
  ethereum: 'ETH liquid staking with Lido, and lending USDT, USDC, DAI and WETH on Aave.',
  arbitrum: 'Lending USDT and USDC on Aave.',
  polygon: 'Lending USDT and USDC on Aave.',
  base: 'Lending USDC on Aave.'
};
