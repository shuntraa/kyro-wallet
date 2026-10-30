// SPDX-License-Identifier: GPL-3.0-or-later
import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Kyro radius tokens (styles.css @theme): without this, `rounded-panel` and `rounded-full`
// would both survive a merge.
const twMerge = extendTailwindMerge({ extend: { theme: { radius: ['panel', 'box', 'ctl', 'card', 'hero', 'field'] } } });

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
