// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: the fee slider on /fees/. The curve comes from packages/swap/src/fees.ts through
// the build; the maths below is the app's (log interpolation, nearest basis point).
(function () {
  'use strict';

  var root = document.querySelector('[data-feecalc]');
  if (!root) return;
  var curve = JSON.parse(root.getAttribute('data-curve'));
  var range = root.querySelector('[data-calc-range]');
  var amount = root.querySelector('[data-calc-amount]');
  var rate = root.querySelector('[data-calc-rate]');
  var fee = root.querySelector('[data-calc-fee]');
  var out = root.querySelector('[data-calc-out]');
  var dot = root.querySelector('[data-calc-dot]');

  function bps(usd) {
    var first = curve[0], last = curve[curve.length - 1];
    if (usd <= first.usd) return first.bps;
    if (usd >= last.usd) return last.bps;
    for (var i = 1; i < curve.length; i++) {
      var a = curve[i - 1], b = curve[i];
      if (usd > b.usd) continue;
      var v = a.bps + ((b.bps - a.bps) * (Math.log(usd) - Math.log(a.usd))) / (Math.log(b.usd) - Math.log(a.usd));
      return Math.floor(v + 0.5);
    }
    return last.bps;
  }
  /** Round numbers while dragging: $1, $23, $230, $2,300. */
  function snap(v) {
    if (v < 100) return Math.round(v);
    var step = Math.pow(10, Math.floor(Math.log10(v)) - 1);
    return Math.round(v / step) * step;
  }
  function money(n, cents) {
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  }
  function y(b) {
    return 1 - (8 + (Math.sqrt(b) / Math.sqrt(500)) * 148) / 170;
  }
  function update() {
    var t = +range.value / 1000;
    var usd = snap(Math.pow(10, t * 5));
    var b = bps(usd);
    var cut = (usd * b) / 10000;
    amount.textContent = money(usd);
    rate.textContent = (b / 100).toFixed(2).replace(/0$/, '') + '%';
    fee.textContent = money(cut, true);
    out.textContent = money(usd - cut, true);
    root.style.setProperty('--t', t.toFixed(4));
    dot.style.left = (t * 100).toFixed(2) + '%';
    dot.style.top = (y(b) * 100).toFixed(2) + '%';
  }
  range.addEventListener('input', update);
  update();
})();
