// SPDX-License-Identifier: GPL-3.0-or-later
// Kyro Wallet site: "Copy" buttons for the donation addresses (no inline handlers, strict CSP).
(function () {
  'use strict';

  var timer = null;

  function announce(text) {
    var status = document.getElementById('copy-status');
    if (!status) return;
    status.textContent = text;
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(function () {
      status.textContent = '';
    }, 4000);
  }

  // Fallback for browsers without the Clipboard API (or outside a secure context).
  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'visually-hidden';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  function copy(button) {
    var target = document.getElementById(button.getAttribute('data-copy-target'));
    if (!target) return;
    var text = target.textContent.trim();
    var row = button.closest('tr');
    var name = row ? row.querySelector('th').textContent.trim() : 'Address';

    var done = function () {
      button.textContent = 'Copied';
      button.classList.add('copied');
      announce(name + ' address copied.');
      window.setTimeout(function () {
        button.textContent = 'Copy';
        button.classList.remove('copied');
      }, 2000);
    };
    var fail = function () {
      announce('Could not copy. Select the address manually.');
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () {
        if (legacyCopy(text)) done();
        else fail();
      });
    } else if (legacyCopy(text)) {
      done();
    } else {
      fail();
    }
  }

  function init() {
    var buttons = document.querySelectorAll('[data-copy-target]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (event) {
        copy(event.currentTarget);
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
