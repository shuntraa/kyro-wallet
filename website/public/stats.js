// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: the usage counters, fresh on every visit. The page ships with the values of its last build;
// this asks /api/stats (this same site, a Pages Function) and rolls to the new value when it changed.
// The browser never contacts anyone else.
(function () {
  var els = document.querySelectorAll('[data-stat]');
  if (!els.length || !window.fetch) return;

  // Same as compact() in website/src/pages.mjs.
  function compact(n) {
    if (n < 1000) return String(n);
    var unit = n < 1e6 ? 'k' : 'M';
    var div = unit === 'k' ? 1e3 : 1e6;
    var tenths = Math.floor((n * 10) / div);
    return String(tenths < 100 ? tenths / 10 : Math.floor(n / div)) + unit + '+';
  }

  fetch('/api/stats', { cache: 'no-store', credentials: 'omit' })
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (s) {
      if (!s) return;
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var v = s[el.getAttribute('data-stat')];
        if (typeof v !== 'number' || !(v > 0)) continue;
        var text = compact(Math.floor(v));
        var was = el.getAttribute('data-shown') || '';
        if (text === was) continue;
        el.setAttribute('data-shown', text);
        el.textContent = text;
        // From the old figure when both are in the same unit (16 → 21, 1.2k+ → 1.3k+), else from 0.
        var unit = function (t) { return (/[kM]/.exec(t) || [''])[0]; };
        var from = unit(text) === unit(was) ? parseFloat(was) || 0 : 0;
        if (window.Kyro && window.Kyro.roll) window.Kyro.roll(el, 900, from);
      }
    })
    .catch(function () {
      // Offline or blocked: the built-in values stay.
    });
})();
