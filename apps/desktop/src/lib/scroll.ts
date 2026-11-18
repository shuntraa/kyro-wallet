// SPDX-License-Identifier: GPL-3.0-or-later
// Scrolls an element into view inside its own scrolling area only. `Element.scrollIntoView` also
// scrolls every ancestor, `overflow: hidden` ones included: it would shift the app frame itself
// (the top bar slides out of the window and stays out after the screen changes).

function scroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Brings the top of `el` to the top of its scrolling area (minus `margin` px). */
export function scrollToTop(el: HTMLElement | null, margin = 16): void {
  if (!el) return;
  const box = scroller(el);
  if (!box) return;
  const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - margin;
  box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

/** For a frame that must never scroll (`overflow: hidden`): undoes any scroll that reaches it. */
export function pinScroll(e: { currentTarget: HTMLElement }): void {
  const t = e.currentTarget;
  if (t.scrollTop !== 0) t.scrollTop = 0;
  if (t.scrollLeft !== 0) t.scrollLeft = 0;
}
