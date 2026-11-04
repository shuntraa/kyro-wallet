// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: usage counters (active wallets and downloads this week), from the public
// stats file the `Stats` workflow keeps on the repository's `stats` branch. Hidden on any failure.
(function () {
  'use strict';

  var URL_STATS = 'https://raw.githubusercontent.com/shuntraa/kyro-wallet/stats/stats/stats.json';

  // < 1000: exact. Then floored, one decimal under 10: 1.2k+, 12k+, 1.2M+, 7M+.
  function compact(n) {
    if (n < 1000) return String(n);
    var unit = n < 1e6 ? 'k' : 'M';
    var div = unit === 'k' ? 1e3 : 1e6;
    // Integer arithmetic first: 2300 / 1000 * 10 would floor to 22.
    var tenths = Math.floor((n * 10) / div);
    var shown = tenths < 100 ? tenths / 10 : Math.floor(n / div);
    return String(shown) + unit + '+';
  }
  window.kyroCompact = compact;

  function count(v) {
    return typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }

  var blocks = document.querySelectorAll('[data-usage]');
  if (!blocks.length || !window.fetch) return;

  fetch(URL_STATS, { credentials: 'omit', referrerPolicy: 'no-referrer' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (s) {
      if (!s || typeof s !== 'object') return;
      Array.prototype.forEach.call(blocks, function (block) {
        var shown = 0;
        Array.prototype.forEach.call(block.querySelectorAll('[data-usage-item]'), function (el) {
          var n = count(s[el.getAttribute('data-usage-item')]);
          if (!n) return;
          var num = el.querySelector('[data-usage-n]');
          if (num) {
            num.textContent = compact(n);
            if (window.Kyro && window.Kyro.roll) window.Kyro.roll(num);
          }
          el.hidden = false;
          shown++;
        });
        if (shown) block.hidden = false;
      });
    })
    .catch(function () {});
})();
