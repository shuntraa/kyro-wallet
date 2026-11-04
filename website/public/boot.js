// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: runs before first paint so motion-only styles apply without a flash.
(function () {
  var m = window.matchMedia;
  if (m && !m('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) document.documentElement.classList.add('js');
})();
