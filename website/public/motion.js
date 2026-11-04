// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: the frame loop, the reveals, the cursor light on cards, the header's popovers and
// the tabs. Scrolling is native everywhere. Every animation runs on time, started once when its element
// enters, so a notched wheel and a finger look the same. Motion is off for reduced motion.
(function () {
  'use strict';

  var root = document.documentElement;
  var motion = root.classList.contains('js');
  var fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /** Exponential damping against real time: the same feel at 60, 144 or 240 Hz, and it cannot overshoot. */
  function damp(a, b, tau, dt) {
    return b + (a - b) * Math.exp(-dt / tau);
  }

  // One frame loop for the whole site, started by the first scene that asks for it: a page of plain
  // reading runs none. K.y is a heavily eased scroll value.
  var jobs = [];
  var K = (window.Kyro = {
    motion: motion,
    fine: fine,
    damp: damp,
    y: window.scrollY,
    frame: function (fn) {
      jobs.push(fn);
      if (jobs.length === 1) requestAnimationFrame(loop);
    }
  });

  // A phone's address bar changes innerHeight while scrolling. K.vh is the small viewport height,
  // which does not move, and K.resize only reports real resizes: nothing re-measures mid-swipe.
  var probe = document.createElement('div');
  probe.className = 'vh-probe';
  document.body.appendChild(probe);
  function readVh() {
    K.vh = probe.offsetHeight || window.innerHeight;
  }
  readVh();
  var coarse = window.matchMedia('(pointer: coarse)').matches;
  var resizers = [], lastW = window.innerWidth, lastH = window.innerHeight;
  K.coarse = coarse;
  K.resize = function (fn) {
    resizers.push(fn);
  };
  window.addEventListener('resize', function () {
    var w = window.innerWidth, h = window.innerHeight;
    if (w === lastW && (coarse || h === lastH)) return;
    lastW = w;
    lastH = h;
    readVh();
    for (var i = 0; i < resizers.length; i++) resizers[i]();
  });

  var last = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    var raw = now - last;
    last = now;
    var dt = raw > 0 ? Math.min(raw / 1000, 0.05) : 1 / 60;
    K.y = damp(K.y, window.scrollY, 0.7, dt);
    for (var i = 0; i < jobs.length; i++) jobs[i](K.y, now, dt);
  }

  /** Rolls the number inside el up from zero, keeping its prefix, suffix and decimals. */
  function roll(el, ms) {
    var full = el.textContent;
    var m = /[\d,]*\.?\d+/.exec(full);
    if (!m || !motion) return;
    var target = parseFloat(m[0].replace(/,/g, ''));
    var dec = (m[0].split('.')[1] || '').length;
    var head = full.slice(0, m.index), tail = full.slice(m.index + m[0].length);
    var t0 = performance.now();
    (function tick(now) {
      var t = Math.min(1, (now - t0) / (ms || 1300));
      var k = 1 - Math.pow(1 - t, 4);
      el.textContent = t < 1 ? head + (target * k).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + tail : full;
      if (t < 1) requestAnimationFrame(tick);
    })(t0);
  }
  K.roll = roll;

  /** Tags what should rise in: section heads and group children stagger, a lone heading gets its own. */
  function reveals() {
    function stagger(list, step) {
      for (var k = 0; k < list.length; k++) {
        list[k].setAttribute('data-reveal', '');
        list[k].style.transitionDelay = Math.min(k * step, 480) + 'ms';
      }
    }
    var heads = document.querySelectorAll('.head-center');
    for (var h = 0; h < heads.length; h++) stagger(heads[h].children, 90);
    var groups = document.querySelectorAll('[data-reveal-group]');
    for (var g = 0; g < groups.length; g++) stagger(groups[g].children, 80);
    var titles = document.querySelectorAll('main h2');
    for (var t = 0; t < titles.length; t++) {
      if (!titles[t].closest('[data-reveal]')) titles[t].setAttribute('data-reveal', '');
    }
    var rows = document.querySelectorAll('[data-rows] .kw-earn');
    for (var r = 0; r < rows.length; r++) rows[r].style.setProperty('--i', r);

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var el = e.target;
          el.classList.add('in');
          io.unobserve(el);
          if (el.hasAttribute('data-roll')) roll(el);
          // Hover transitions must not wait for the entrance delay.
          if (el.style.transitionDelay) {
            window.setTimeout(function () {
              el.style.transitionDelay = '';
            }, 1400);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );
    var fees = document.querySelectorAll('.fee-value');
    for (var f = 0; f < fees.length; f++) if (!fees[f].querySelector('[data-roll]')) fees[f].setAttribute('data-roll', '');
    var items = document.querySelectorAll('[data-reveal], [data-roll]');
    for (var j = 0; j < items.length; j++) io.observe(items[j]);
    window.addEventListener('beforeprint', function () {
      for (var p = 0; p < items.length; p++) items[p].classList.add('in');
    });
  }

  /** The soft light that follows the pointer inside a card. */
  function spotlight() {
    document.addEventListener(
      'pointermove',
      function (e) {
        var card = e.target.closest ? e.target.closest('.spot') : null;
        if (!card) return;
        var b = card.getBoundingClientRect();
        card.style.setProperty('--mx', (e.clientX - b.left).toFixed(0) + 'px');
        card.style.setProperty('--my', (e.clientY - b.top).toFixed(0) + 'px');
      },
      { passive: true }
    );
  }

  // The header's popovers: Escape, a click outside or a followed link closes them, with a short exit.
  function menu() {
    document.querySelectorAll('details[data-pop]').forEach(function (m) {
      var timer = 0;
      function close() {
        if (!m.open || timer) return;
        if (!motion) {
          m.open = false;
          return;
        }
        m.classList.add('closing');
        timer = window.setTimeout(function () {
          timer = 0;
          m.open = false;
          m.classList.remove('closing');
        }, 140);
      }
      m.querySelector('summary').addEventListener('click', function (e) {
        if (m.open) {
          e.preventDefault();
          close();
        }
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && m.open) {
          close();
          m.querySelector('summary').focus();
        }
      });
      document.addEventListener('click', function (e) {
        if (m.open && (!m.contains(e.target) || e.target.closest('a'))) close();
      });
    });
  }

  /** One hover light that slides from link to link in the header. */
  function navLight() {
    var list = document.querySelector('.nav > ul');
    if (!list) return;
    var hl = document.createElement('span');
    hl.className = 'nav-hl';
    list.appendChild(hl);
    list.addEventListener('pointerover', function (e) {
      var t = e.target.closest('a, summary');
      if (!t || t.closest('.nav-more-panel')) return hl.classList.remove('on');
      var b = t.getBoundingClientRect();
      hl.style.width = b.width + 'px';
      hl.style.transform = 'translate3d(' + (b.left - list.getBoundingClientRect().left) + 'px, 0, 0)';
      hl.classList.add('on');
    });
    list.addEventListener('pointerleave', function () {
      hl.classList.remove('on');
    });
  }

  /** Tabs with the keys the ARIA pattern expects. Without JavaScript all the panels simply show. */
  function select(tabs, i, focus) {
    tabs.forEach(function (t, n) {
      var on = n === i;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).classList.toggle('on', on);
    });
    if (focus) tabs[i].focus();
    // Only the bar itself moves, sideways on a phone: choosing a tab never scrolls the page.
    tabs[i].parentNode.scrollLeft = tabs[i].offsetLeft - 24;
  }
  function tabs() {
    document.querySelectorAll('[role="tablist"]').forEach(function (list) {
      var all = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
      all.forEach(function (t, i) {
        t.addEventListener('click', function () {
          select(all, i);
        });
      });
      list.addEventListener('keydown', function (e) {
        var i = all.indexOf(document.activeElement), n = all.length;
        var to = { ArrowRight: (i + 1) % n, ArrowLeft: (i + n - 1) % n, Home: 0, End: n - 1 }[e.key];
        if (i < 0 || to === undefined) return;
        e.preventDefault();
        select(all, to, true);
      });
    });
  }

  // /#support is a closed answer in the FAQ: open it when the link points at it.
  function hashOpen() {
    var id = window.location.hash.slice(1);
    var el = id && document.getElementById(id);
    var panel = el && el.closest('[role="tabpanel"]');
    if (panel) {
      document.querySelector('[aria-controls="' + panel.id + '"]').click();
      el.scrollIntoView();
    }
    if (el && el.tagName === 'DETAILS') {
      el.open = true;
      el.scrollIntoView();
    }
  }

  menu();
  tabs();
  hashOpen();
  window.addEventListener('hashchange', hashOpen);

  if (motion) {
    reveals();
    if (fine) {
      spotlight();
      navLight();
    }
  }
})();
