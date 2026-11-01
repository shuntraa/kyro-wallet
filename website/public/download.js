// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: download button for the visitor's system.
// Only navigator.* is read, locally. Without JavaScript the buttons point to the download page.
(function () {
  'use strict';

  var BASE = 'https://github.com/shuntraa/kyro-wallet/releases/latest/download/';

  var OS = {
    windows: { file: 'Kyro-windows-x64-setup.exe', label: 'Download for Windows', icon: 'os-windows' },
    macos: { file: 'Kyro-macos.dmg', label: 'Download for macOS', icon: 'os-apple' },
    linux: { file: 'Kyro-linux-x86_64.AppImage', label: 'Download for Linux', icon: 'os-linux' }
  };

  function detect() {
    var nav = window.navigator || {};
    var ua = String(nav.userAgent || '');
    var platform = String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || '');
    var touch = Number(nav.maxTouchPoints || 0);

    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (nav.userAgentData && nav.userAgentData.mobile)) return 'mobile';
    // iPadOS reports itself as a Mac, but with a touch screen.
    if (/Mac/i.test(platform) && touch > 1) return 'mobile';
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows';
    if (/Mac/i.test(platform) || /Mac OS X|Macintosh/i.test(ua)) return 'macos';
    if (/CrOS/i.test(ua)) return 'unknown';
    if (/Linux|X11/i.test(platform) || /Linux|X11/i.test(ua)) return 'linux';
    return 'unknown';
  }

  function each(selector, fn) {
    var list = document.querySelectorAll(selector);
    for (var i = 0; i < list.length; i++) fn(list[i]);
  }

  function apply() {
    var os = detect();
    if (os === 'mobile') {
      each('[data-dl-other]', function (el) {
        el.textContent = 'Kyro is a desktop app: open this page on your computer.';
      });
      return;
    }
    var info = OS[os];
    if (!info) return;

    // Each primary download button: <a data-dl-hero> with [data-dl-label] and [data-dl-icon] inside.
    each('[data-dl-hero]', function (a) {
      a.href = BASE + info.file;
      var label = a.querySelector('[data-dl-label]');
      if (label) label.textContent = info.label;
      var icon = a.querySelector('[data-dl-icon]');
      if (icon) icon.classList.add(info.icon);
    });
    each('[data-dl-other]', function (el) {
      el.textContent = 'Other systems and checksums';
    });
    each('.os-row[data-os="' + os + '"]', function (row) {
      row.setAttribute('data-current', 'true');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})();
