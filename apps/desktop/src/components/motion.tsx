// SPDX-License-Identifier: GPL-3.0-or-later
// Motion helpers. Rules: fast (150–350 ms), enter-only (never delays a click or a navigation),
// and off under prefers-reduced-motion (MotionConfig reducedMotion="user" in App + the CSS
// media query in styles.css).

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { animate, useReducedMotion } from 'motion/react';

export const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

/** Screen entrance (App's <motion.main>). */
export const screenEnter = {
  // Not from 0: if rAF is paused (hidden window) the screen must still be readable.
  initial: { opacity: 0.25, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.24, ease: EASE_OUT },
} as const;

/**
 * Animated number: eases from the previous value to the new one (count-up from `from` on the
 * first display). Purely visual: the real value is what the caller passes, always used for
 * aria-labels and copies.
 */
export function useTicker(value: number, { duration = 0.5, from }: { duration?: number; from?: number } = {}): number {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(() => (reduce || from === undefined ? value : from));
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    if (reduce || !Number.isFinite(value) || shownRef.current === value) {
      setShown(value);
      return;
    }
    const ctrl = animate(shownRef.current, value, { duration, ease: EASE_OUT, onUpdate: setShown });
    return () => ctrl.stop();
  }, [value, reduce, duration]);
  return shown;
}

/** Live `matchMedia` (e.g. a shorter hero when the window is at its 720 px minimum height). */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const f = () => setOn(m.matches);
    f();
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [query]);
  return on;
}

/** Index for the CSS `.stagger` / `.rise` entrances. */
export function idx(i: number): CSSProperties {
  return { ['--i' as string]: i } as CSSProperties;
}
