// SPDX-License-Identifier: GPL-3.0-or-later
// HTML replicas of the Kyro app, drawn from apps/desktop (same tokens, same screens). All numbers
// are demo numbers: running digits, so nobody takes them for a real balance, rate or price.

import { esc, iconOf } from './layout.mjs';

const ico = (file, cls = '') => `<img class="tok${cls ? ' ' + cls : ''}" src="/img/coins/${file}.svg" width="32" height="32" alt="" decoding="async">`;

const svg = (d, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;

export const I = {
  portfolio: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  assets: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
  swap: 'M4 8h13l-3-3M20 16H7l3 3',
  earn: 'M3.5 6.5a6 2.5 0 1012 0 6 2.5 0 10-12 0zM3.5 6.5v4.5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V6.5M3.5 11v4.5c0 1.4 2.7 2.5 6 2.5.9 0 1.8-.1 2.5-.3M18.5 21v-7M15.5 17l3-3 3 3',
  history: 'M12 7v5l3 2M12 21a9 9 0 110-18 9 9 0 010 18z',
  settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 9a2 2 0 100-4 2 2 0 000 4zM8 19a2 2 0 100-4 2 2 0 000 4z',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  shield: 'M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6l8-3z',
  code: 'M9 8l-5 4 5 4M15 8l5 4-5 4',
  window: 'M4 5h16v14H4zM4 9h16',
  search: 'M11 18a7 7 0 110-14 7 7 0 010 14zM20 20l-4-4',
  chev: 'M6 9l6 6 6-6',
  check: 'M5 12.5l4.5 4.5L19 7.5'
};
export const icon = (k, cls) => svg(I[k], cls);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Smooth line through n random points, as an SVG path in a w x h box. */
function line(seed, n, w, h, trend = 0.35) {
  const r = rng(seed);
  const pts = [];
  let v = trend < 0 ? 0.7 : 0.35;
  for (let i = 0; i < n; i++) {
    v += (r() - 0.5) * 0.3 + trend / n;
    v = Math.min(0.94, Math.max(0.08, v));
    pts.push([(i / (n - 1)) * w, h - v * h]);
  }
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return { d, end: pts[n - 1] };
}

export const spark = (seed, cls = 'up') => {
  const { d } = line(seedOf(seed), 14, 80, 24, cls === 'up' ? 0.4 : -0.4);
  return `<svg class="spark ${cls}" viewBox="0 0 80 24" fill="none" aria-hidden="true"><path pathLength="1" d="${d}"/></svg>`;
};

function chart() {
  const { d } = line(23, 52, 800, 150, 0.5);
  return `<svg class="kw-chart" viewBox="0 0 800 150" preserveAspectRatio="none" fill="none" aria-hidden="true">
    <defs><linearGradient id="kw-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7cc4ff" stop-opacity=".2"/><stop offset="1" stop-color="#7cc4ff" stop-opacity="0"/></linearGradient></defs>
    <path class="kw-area" d="${d}L800 150L0 150Z" fill="url(#kw-area)"/>
    <path class="kw-line" pathLength="1" d="${d}" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

const ROWS = [
  ['btc', 'Bitcoin', 'BTC', '$5,678.90', '0.12345678 BTC', '46%', 'up'],
  ['eth', 'Ethereum', 'ETH', '$3,456.78', '1.2345 ETH', '28%', 'up'],
  ['xmr', 'Monero', 'XMR', '$1,234.56', '12.3456 XMR', '10%', 'down'],
  ['sol', 'Solana', 'SOL', '$987.65', '12.34 SOL', '8%', 'up'],
  ['ada', 'Cardano', 'ADA', '$654.32', '1,234.5 ADA', '5%', 'down'],
  ['doge', 'Dogecoin', 'DOGE', '$321.09', '1,234 DOGE', '3%', 'up']
];

const assetRow = ([f, name, t, val, amt, share, dir]) => `
          <div class="kw-row">
            <span class="kw-coin">${ico(f)}<span><b>${name}</b><small>${t}</small></span></span>
            <span class="kw-trend">${spark(t, dir)}</span>
            <span class="kw-val"><b>${val}</b><small>${amt}</small></span>
            <span class="kw-share">${share}</span>
          </div>`;

const portfolio = () => `
      <div class="kw-screen is-on" data-screen="0">
        <div class="kw-top">
          <div>
            <p class="kw-label">Total value</p>
            <p class="kw-total">$<span data-balance>12,345</span><span class="dim">.67</span></p>
            <p class="kw-delta"><span>▲ $123.45 · 1.23%</span> today</p>
          </div>
          <div class="kw-actions">
            <div class="kw-seg"><i class="on">1D</i><i>1W</i><i>1M</i><i>1Y</i><i>All</i></div>
            <div class="kw-btns"><i class="kw-b on">${icon('up')}Send</i><i class="kw-b">${icon('down')}Receive</i><i class="kw-b">${icon('swap')}Swap</i></div>
          </div>
        </div>
        ${chart()}
        <div class="kw-cols">
          <div class="kw-panel kw-assets">
            <div class="kw-tabs"><b>My assets</b><span>Market</span><span>Favorites</span></div>
            ${ROWS.map(assetRow).join('')}
          </div>
          <div class="kw-panel kw-side">
            <p class="kw-label">Allocation</p>
            <div class="kw-alloc"><i class="a1"></i><i class="a2"></i><i class="a3"></i><i class="a4"></i><i class="a5"></i></div>
            <div class="kw-vault">${icon('shield')}<span><b>Vault</b><small>Keys encrypted on this device</small></span><em>Unlocked</em></div>
            <div class="kw-kv"><span>Auto-lock</span><b>14:54</b></div>
            <div class="kw-bar"><i></i></div>
            <div class="kw-kv"><span>Hardware wallet</span><b class="ice">Add</b></div>
            <div class="kw-kv"><span>Unlimited approvals</span><b class="up">None</b></div>
            <div class="kw-kv"><span>Recovery phrase</span><b class="up">Imported</b></div>
            <div class="kw-kv"><span>Tor</span><b class="ice">On</b></div>
          </div>
        </div>
      </div>`;

const swapScreen = () => `
      <div class="kw-screen" data-screen="1">
        <div class="kw-head"><h3>Swap</h3><i class="kw-pill">Bitcoin ${icon('chev')}</i><div class="kw-seg kw-slip"><i>0.1%</i><i class="on">0.5%</i><i>1%</i></div></div>
        <div class="kw-swap-grid">
          <div class="kw-panel kw-swapcard">
            <div class="kw-field">
              <p class="kw-label">You send</p>
              <div><strong data-sw-from>1.0000</strong><i class="kw-token">${ico('btc')}BTC${icon('chev')}</i></div>
            </div>
            <i class="kw-flip">${icon('down')}</i>
            <div class="kw-field">
              <p class="kw-label">You receive ≈</p>
              <div><strong data-sw-to>100.00</strong><i class="kw-token">${ico('xmr')}XMR${icon('chev')}</i></div>
              <small>Service fee included</small>
            </div>
            <i class="kw-review">Review the swap</i>
          </div>
          <div class="kw-panel kw-best">
            <b>Best price</b>
            <div class="kw-kv"><span>Rate</span><b>1 BTC ≈ 100 XMR</b></div>
            <div class="kw-kv"><span>You receive</span><b>≈ 100 XMR</b></div>
            <div class="kw-kv"><span>Network fee</span><b>at confirmation</b></div>
            <hr>
            <p class="kw-label">Providers compared</p>
            <div class="kw-kv"><span>Exolix</span><b>100.00 <em>Best</em></b></div>
            <div class="kw-kv"><span>Other quote</span><b>99.99</b></div>
          </div>
        </div>
      </div>`;

export const EARN = [
  ['steth', 'Ethereum · Lido', 'Liquid staking', '1.23%', 'stETH swappable', 'None'],
  ['usdc', 'USD Coin · Aave', 'Lending', '2.34%', 'None', 'None'],
  ['usdt', 'Tether · Aave', 'Lending', '3.45%', 'None', 'None'],
  ['sol', 'Solana', 'Staking', '4.56%', '≈ 2–3 days', 'None'],
  ['ada', 'Cardano', 'Staking', '5.67%', 'None', '2 ADA'],
  ['trx', 'TRON', 'Staking', '6.78%', '14 days', '1 TRX']
];

export const earnRow = ([f, name, type, apy, lock, min]) => `
          <div class="kw-earn">
            <span class="kw-coin">${ico(f)}<span><b>${name}</b><small>${type}</small></span></span>
            <span class="kw-apy"><b>${apy}</b><small>est. APY</small></span>
            <span class="kw-meta"><small>Lock</small>${lock}</span>
            <span class="kw-meta kw-min"><small>Minimum</small>${min}</span>
            <i class="kw-b">Start</i>
          </div>`;

const earnScreen = () => `
      <div class="kw-screen" data-screen="2">
        <div class="kw-head"><div><h3>Earn</h3><p>Rates are estimates, never guaranteed.</p></div><div class="kw-seg"><i class="on">All</i><i>Staking</i><i>Stablecoins</i></div></div>
        <div class="kw-panel kw-earnlist">${EARN.map(earnRow).join('')}</div>
      </div>`;

const railItem = (k, label, i) => `<i class="kw-rail-i${i === 0 ? ' on' : ''}"${i >= 0 ? ` data-rail="${i}"` : ''}>${icon(k)}<span>${label}</span></i>`;

/** The Kyro window. The text alternative lives on the wrapper; everything inside is decorative. */
export const appWindow = () => `
  <div class="kw" role="img" aria-label="The Kyro app with demo numbers, moving through the Portfolio, Swap and Earn screens.">
    <div class="kw-in" aria-hidden="true">
      <div class="kw-titlebar">
        <span class="kw-brand"><img src="/img/kyro-mark-dark.svg" width="16" height="16" alt=""><b>Kyro</b><span>/</span><span>Main account</span>${icon('chev')}</span>
        <span class="kw-search">${icon('search')}Search for an asset, an address…</span>
        <span class="kw-demo">DEMO</span>
        <span class="kw-win"><i></i><i></i><i></i></span>
      </div>
      <div class="kw-body">
        <div class="kw-rail">
          ${railItem('portfolio', 'Portfolio', 0)}${railItem('assets', 'Assets', -1)}${railItem('swap', 'Swap', 1)}${railItem('earn', 'Earn', 2)}${railItem('history', 'History', -1)}
          <span class="kw-rail-end">${railItem('settings', 'Settings', -1)}</span>
        </div>
        <div class="kw-screens">${portfolio()}${swapScreen()}${earnScreen()}</div>
      </div>
    </div>
  </div>`;

/** Small app-style card: assets list, used on inner pages. */
export const assetsCard = () => `
  <div class="kw-card" role="img" aria-label="Kyro asset list with demo numbers: Bitcoin, Ethereum, Monero, Solana and Cardano."><div aria-hidden="true">
    <div class="kw-tabs"><b>My assets</b><span>Market</span><span>Favorites</span></div>
    ${ROWS.map(assetRow).join('')}
  </div></div>`;

export const earnCard = (only) => `
  <div class="kw-card" role="img" aria-label="Kyro Earn list with demo rates. Rates are estimates."><div aria-hidden="true">${EARN.filter((r) => !only || only.includes(r[0])).map(earnRow).join('')}</div></div>`;

/** The native confirmation window, as the app shell draws it. */
export const confirmCard = () => `
  <div class="dlg" role="img" aria-label="Kyro confirmation window: amount, recipient, network and network fee, with Cancel and Confirm buttons."><div aria-hidden="true">
    <div class="dlg-bar"><img src="/img/kyro-mark-dark.svg" width="14" height="14" alt="">Kyro · Confirm transaction</div>
    <div class="dlg-body">
      <div class="dlg-amount">${ico('eth')}<strong>1.2345 ETH</strong></div>
      <div class="kw-kv"><span>To</span><b class="mono">0x1234…cdef</b></div>
      <div class="kw-kv"><span>Network</span><b>Ethereum</b></div>
      <div class="kw-kv"><span>Network fee</span><b>0.00123 ETH</b></div>
      <p>Decoded by the Rust core. Nothing is sent until you confirm.</p>
      <div class="dlg-actions"><i>Cancel</i><i class="on">Confirm</i></div>
    </div>
  </div></div>`;

/** The vault panel from the Portfolio screen. */
export const vaultCard = () => `
  <div class="kw-card kw-card-narrow" role="img" aria-label="Kyro vault panel: keys encrypted on this device, auto-lock timer, no unlimited approvals, Tor on."><div aria-hidden="true">
    <div class="kw-vault">${icon('shield')}<span><b>Vault</b><small>Keys encrypted on this device</small></span><em>Unlocked</em></div>
    <div class="kw-kv"><span>Auto-lock</span><b>14:54</b></div>
    <div class="kw-bar"><i></i></div>
    <div class="kw-kv"><span>Hardware wallet</span><b class="ice">Add</b></div>
    <div class="kw-kv"><span>Unlimited approvals</span><b class="up">None</b></div>
    <div class="kw-kv"><span>Recovery phrase</span><b class="up">Imported</b></div>
    <div class="kw-kv"><span>Tor</span><b class="ice">On</b></div>
  </div></div>`;

/** A generic hardware wallet on a cable, with the app's connect row. No vendor artwork. */
export const deviceCard = () => `
  <div class="device" data-device role="img" aria-label="A hardware wallet connected to Kyro, asking you to confirm on the device."><div class="device-in" aria-hidden="true">
    <div class="device-app">
      <p class="kw-label">Hardware wallet</p>
      <div class="device-row"><span class="device-dot"></span><b>Connected</b><i class="kw-b on">Connect</i></div>
    </div>
    <svg class="device-cable" viewBox="0 0 300 70" preserveAspectRatio="none" fill="none"><path pathLength="1" vector-effect="non-scaling-stroke" d="M0 12C90 12 80 58 170 58S240 34 300 34"/></svg>
    <div class="device-body">
      <div class="device-screen"><small>Kyro</small><b>Confirm on device</b><span>1.2345 BTC</span></div>
      <div class="device-keys"><i></i><i></i></div>
    </div>
  </div></div>`;

/** Swap widget with the coin that flips from one token to the other (scenes.js drives it). */
export const swapWidget = () => `
  <div class="sw" data-swap role="img" aria-label="Swapping 1 BTC for about 100 XMR in Kyro, with demo numbers and the service fee included."><div class="sw-in" aria-hidden="true">
    <div class="sw-side">
      <p class="kw-label">You send</p>
      <strong data-a>1.0000</strong><small data-at>BTC</small>
    </div>
    <div class="sw-coin"><span class="sw-ring"></span><div class="sw-spin" data-spin><img data-f src="/img/coins/btc.svg" width="96" height="96" alt=""><img data-b src="/img/coins/xmr.svg" width="96" height="96" alt=""></div></div>
    <div class="sw-side sw-right">
      <p class="kw-label">You receive ≈</p>
      <strong data-bn>100.00</strong><small data-bt>XMR</small>
    </div>
    <div class="sw-foot"><span data-rate>1 BTC ≈ 100 XMR</span><span>Service fee included</span></div>
  </div></div>`;

/** Per-chain app card, for the chain pages. */
export function coinCard(c) {
  const f = c.features;
  const acts = ['Send', 'Receive', f.swap && 'Swap', f.staking && 'Stake'].filter(Boolean);
  return `
  <div class="kw-card coin-card c-${c.slug} spot" role="img" aria-label="${esc(c.name)} in Kyro, with demo numbers."><div aria-hidden="true">
    <div class="kw-coin"><img class="tok" src="/img/coins/${iconOf(c)}.svg" width="32" height="32" alt=""><span><b>${esc(c.name)}</b><small>${esc(c.ticker)}</small></span><em class="kw-demo">DEMO</em></div>
    <p class="coin-bal">1.2345 <span>${esc(c.ticker)}</span></p>
    <p class="coin-fiat">$123.45</p>
    <svg class="coin-line" viewBox="0 0 400 90" preserveAspectRatio="none" fill="none"><path pathLength="1" vector-effect="non-scaling-stroke" d="${line(seedOf(c.slug), 16, 400, 90, 0.4).d}"/></svg>
    <div class="kw-btns">${acts.map((a, i) => `<i class="kw-b${i ? '' : ' on'}">${a}</i>`).join('')}</div>
  </div></div>`;
}
