// SPDX-License-Identifier: GPL-3.0-or-later
// Stroke icons (24×24 grid) drawn after the approved mockup.

import type { SVGProps } from 'react';

type P = Omit<SVGProps<SVGSVGElement>, 'stroke'> & { size?: number; sw?: number };

function Svg({ size = 18, sw = 1.9, children, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const IconWallet = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="9" rx="2" />
    <rect x="14" y="3" width="7" height="5" rx="2" />
    <rect x="14" y="12" width="7" height="9" rx="2" />
    <rect x="3" y="16" width="7" height="5" rx="2" />
  </Svg>
);
export const IconLayers = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l9 5-9 5-9-5 9-5z" />
    <path d="M3 13l9 5 9-5" />
  </Svg>
);
export const IconSwap = (p: P) => (
  <Svg {...p}>
    <path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" />
  </Svg>
);
/** Staking: a sprout growing from a coin. */
export const IconStake = (p: P) => (
  <Svg {...p}>
    <ellipse cx="12" cy="18" rx="7" ry="3" />
    <path d="M12 15V8" />
    <path d="M12 10c0-3 2-5 5-5 0 3-2 5-5 5z" />
    <path d="M12 12c0-2.5-1.7-4-4-4 0 2.5 1.7 4 4 4z" />
  </Svg>
);
export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);
export const IconSliders = (p: P) => (
  <Svg {...p}>
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="18" cy="18" r="2" />
  </Svg>
);
export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);
export const IconShield = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />
  </Svg>
);
export const IconEye = (p: P) => (
  <Svg {...p}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);
export const IconEyeOff = (p: P) => (
  <Svg {...p}>
    <path d="M3 3l18 18M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7c1.7 0 3.2-.5 4.5-1.2" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Svg>
);
export const IconUp = (p: P) => (
  <Svg sw={2.2} {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);
export const IconDown = (p: P) => (
  <Svg sw={2.2} {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Svg>
);
export const IconChevronDown = (p: P) => (
  <Svg sw={2.2} {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);
export const IconChevronRight = (p: P) => (
  <Svg sw={2.2} {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);
export const IconBack = (p: P) => (
  <Svg sw={2.2} {...p}>
    <path d="M15 6l-6 6 6 6" />
  </Svg>
);
export const IconSearch = (p: P) => (
  <Svg sw={2} {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4-4" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg sw={2} {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconImport = (p: P) => (
  <Svg sw={2} {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Svg>
);
export const IconUsbKey = (p: P) => (
  <Svg sw={2} {...p}>
    <rect x="7" y="2" width="10" height="14" rx="2" />
    <path d="M12 16v6M9 6h6" />
  </Svg>
);
export const IconPhoneKey = (p: P) => (
  <Svg sw={2} {...p}>
    <rect x="6" y="3" width="12" height="18" rx="3" />
    <path d="M12 8v5" />
  </Svg>
);
export const IconCopy = (p: P) => (
  <Svg sw={2} {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg sw={2.2} {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);
export const IconWarn = (p: P) => (
  <Svg sw={2} {...p}>
    <path d="M12 3l10 18H2L12 3z" />
    <path d="M12 10v5M12 18h.01" />
  </Svg>
);
export const IconInfo = (p: P) => (
  <Svg sw={2} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v6M12 7.5h.01" />
  </Svg>
);
export const IconStar = ({ filled, ...p }: P & { filled?: boolean }) => (
  <Svg sw={1.8} {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.8l-5.3 2.8 1-5.8-4.2-4.1 5.9-.9L12 3.5z" />
  </Svg>
);
export const IconUpDown = (p: P) => (
  <Svg sw={2} {...p}>
    <path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4" />
  </Svg>
);
export const IconQr = (p: P) => (
  <Svg sw={2} {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <path d="M14 14h3v3M21 14v.01M14 21h7v-4" />
  </Svg>
);
export const IconRefresh = (p: P) => (
  <Svg sw={2} {...p}>
    <path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4" />
  </Svg>
);
export const IconTrash = (p: P) => (
  <Svg sw={2} {...p}>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </Svg>
);
export const IconX = (p: P) => (
  <Svg sw={2} {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const IconTor = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="13.5" r="7.5" />
    <path d="M12 6c-2.6 1.6-4.2 4.4-4.2 7.5S9.4 19.4 12 21" />
    <path d="M12 6c1.6 1.8 2.4 4.4 2.4 7.5S13.6 19.2 12 21" />
    <path d="M12 6V3" />
  </Svg>
);
export const IconGlobe = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
  </Svg>
);
