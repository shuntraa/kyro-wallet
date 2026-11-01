// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: scroll reveals, header state, reading progress, the tilted app screenshot, the
// floating app cut-outs, the pointer spotlight on cards and the small-screen menu.
(function () {
  'use strict';

  var root = document.documentElement;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduced && 'IntersectionObserver' in window) root.classList.add('js');

  function init() {
    var header = document.querySelector('.site-header');
    var pill = document.querySelector('.nav-pill');
    var frame = document.getElementById('showcase');
    var chips = document.querySelectorAll('.chip, .win-float');
    var stages = document.querySelectorAll('[data-stage]');
    var ticking = false;

    function onScroll() {
      ticking = false;
      var y = window.scrollY || 0;
      var vh = window.innerHeight || 800;
      if (header) header.classList.toggle('scrolled', y > 8);
      if (pill) {
        var max = document.documentElement.scrollHeight - vh;
        pill.style.setProperty('--progress', max > 0 ? Math.min(y / max, 1).toFixed(4) : '0');
      }
      if (reduced) return;
      if (frame) {
        var r = frame.getBoundingClientRect();
        var p = Math.min(Math.max((vh - r.top) / (vh * 0.75), 0), 1);
        frame.style.setProperty('--tilt', (18 * (1 - p)).toFixed(2) + 'deg');
        frame.style.setProperty('--zoom', (0.94 + 0.06 * p).toFixed(3));
      }
      for (var s = 0; s < stages.length; s++) {
        var sr = stages[s].getBoundingClientRect();
        if (sr.bottom < -200 || sr.top > vh + 200) continue;
        var sp = Math.max(-1, Math.min(1, (vh / 2 - (sr.top + sr.height / 2)) / (vh * 0.7)));
        stages[s].style.setProperty('--p', sp.toFixed(3));
      }
      for (var i = 0; i < chips.length; i++) {
        var rect = chips[i].parentNode.getBoundingClientRect();
        var speed = i % 2 ? -0.08 : 0.06;
        chips[i].style.setProperty('--float', ((rect.top + rect.height / 2 - vh / 2) * speed).toFixed(1) + 'px');
      }
    }
    window.addEventListener(
      'scroll',
      function () {
        if (!ticking) {
          ticking = true;
          window.requestAnimationFrame(onScroll);
        }
      },
      { passive: true }
    );
    window.addEventListener('resize', onScroll);
    onScroll();

    var menu = document.querySelector('.menu');
    if (menu) {
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && menu.open) {
          menu.open = false;
          menu.querySelector('summary').focus();
        }
      });
      document.addEventListener('click', function (e) {
        if (menu.open && (!menu.contains(e.target) || e.target.closest('a'))) menu.open = false;
      });
    }

    if (!reduced && window.matchMedia('(hover: hover)').matches) {
      document.addEventListener(
        'pointermove',
        function (e) {
          var el = e.target.closest && e.target.closest('.spot');
          if (!el) return;
          var b = el.getBoundingClientRect();
          el.style.setProperty('--mx', (e.clientX - b.left).toFixed(0) + 'px');
          el.style.setProperty('--my', (e.clientY - b.top).toFixed(0) + 'px');
        },
        { passive: true }
      );
    }

    if (!root.classList.contains('js')) return;

    var groups = document.querySelectorAll('[data-reveal-group]');
    for (var g = 0; g < groups.length; g++) {
      var kids = groups[g].children;
      for (var k = 0; k < kids.length; k++) {
        kids[k].setAttribute('data-reveal', '');
        kids[k].style.transitionDelay = Math.min(k * 45, 600) + 'ms';
      }
    }
    var cards = document.querySelectorAll('.bento > .card');
    for (var c = 0; c < cards.length; c++) cards[c].style.transitionDelay = (c % 4) * 70 + 'ms';

    function clearDelay(el) {
      el.style.transitionDelay = '';
    }

    var io = new IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) continue;
          var el = entries[i].target;
          el.classList.add('in');
          if (el.style.transitionDelay) window.setTimeout(clearDelay.bind(null, el), 1600);
          io.unobserve(el);
        }
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.06 }
    );
    var items = document.querySelectorAll('[data-reveal]');
    for (var j = 0; j < items.length; j++) io.observe(items[j]);

    window.addEventListener('beforeprint', function () {
      for (var p = 0; p < items.length; p++) items[p].classList.add('in');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
