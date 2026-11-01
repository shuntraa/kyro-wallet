# Kyro Wallet — visual identity

## The name

**Kyro**, from the Greek *kruos*, "the cold". A nod to *cold storage*: your keys stay cold, offline, at your place. The product is called **Kyro Wallet**; in the logo, "kyro" is bold and "wallet" is lighter.

Tagline: **"Your keys stay cold."**

## Direction

- **Dark, always.** No light theme: a vault is black. The whole interface is designed for a near-black background.
- **An instrument of cold, not a dashboard.** Blue-black ink, fine rules rather than a card around everything, tabular figures, labels in normal text. The balance and the curves rest on the page, on a baseline.
- **A single accent.** **Frost blue** (`#7CC4FF`) is reserved for selection, curves and whatever needs checking (address blocks, verification receipt). The primary action is **frosted white** (`#E4ECF3`, ink text); everything else is a discreet outline.
- **Rounded curves**: all charts go through a Catmull-Rom → Bézier interpolation (no angles), with a very light frost veil under the line.
- **A real desktop application**, not a web page: integrated title bar, navigation rail, status bar at the bottom (sync, blocks, RPC latency, testnet, version).
- **"In plain words".** Every sensitive action (send, swap, approval) is summarized in one sentence before signing.

## Layout

| Zone | Content |
|---|---|
| Title bar (40 px) | logo, active account, `Ctrl K` search, window buttons |
| Rail (84 px) | Wallet, Assets, Swap, History · at the bottom: Settings, lock |
| Content | current screen; Send and Receive open from the Wallet with a back button |
| Status bar (28 px) | network status in `Geist Mono`, TESTNET badge, version |

Reference window: **1440 × 900**. Planned minimum size: 1100 × 720.

## "App" behavior (mandatory)

- **No selectable text**: `user-select: none` on the whole interface, except in input fields.
- **No blue highlight**: transparent `::selection`, `-webkit-tap-highlight-color: transparent`, no "copy" menu on long press (`-webkit-touch-callout: none`).
- **No drag and drop** of images and icons (`-webkit-user-drag: none`).
- **Right click disabled** outside fields (Tauri side: `contextmenu` blocked).
- **Copy only via the "Copy" buttons**, which go through the Rust core (and the clipboard alert).
- Keyboard focus visible only during keyboard navigation (`:focus-visible`, 2 px frost blue outline).

## Logo

- **Open ring**: the code is open.
- **Frost blue square at the center**: your key, which never leaves the ring.

| File ([`brand/`](../brand/)) | Usage |
|---|---|
| `kyro-mark-dark.svg` | symbol on a dark background — **main usage** |
| `kyro-mark.svg` | symbol on a light background (GitHub README, documentation) |
| `kyro-icon.svg` | 1024 px application icon (dark background) — **default** |
| `kyro-icon-blue.svg` | application icon, dark blue variant |
| `kyro-logo-dark.svg` | symbol + "kyro wallet", dark background |
| `kyro-logo.svg` | symbol + "kyro wallet", light background |

The full logos use the Geist font for the text: to be vectorized before any use outside the application.

## Colors (tokens)

| Token | Value | Role |
|---|---|---|
| `bg` | `#0A0B0D` | window background |
| `bgDeep` | `#08090B` | status bar |
| `card` | `#121418` | cards |
| `cardHero` | `#101215` | large balance card, charts |
| `raised` | `#16181C` | fields, raised rows |
| `control` | `#1D1F24` / `#22252B` | secondary buttons, selected tab |
| `line` | `#1E2228` / `#292E35` / `#353B44` | rules and borders (three intensities) |
| `text` | `#F5F7FA` | main text |
| `text2` | `#C8CDD6` | list text |
| `mute` | `#8C929D` | secondary text |
| `faint` | `#5E6470` | decimals, discreet labels |
| `primary` | `#E4ECF3` | frosted white: primary action (`onPrimary` text `#08090B`) |
| `ice` | `#7CC4FF` | frost blue: selection, curves, to be checked |
| `iceSoft` | `rgba(124,196,255,.08–.16)` | frost blue backgrounds |
| `iceText` | `#CDE9FF` / `#A9D8FF` | text on a frost blue background |
| `up` | `#3DDC97` | rise, success |
| `down` | `#FF6B6B` | fall, danger |
| `warn` | `#F5B74F` | warning, testnet |

Network colors (dots, breakdown): Bitcoin `#F7931A`, Ethereum `#627EEA`, Solana `#35D0BA`, USD Coin `#2F8BE6`, Arbitrum `#9FD8FF`.

## Customizable fees

Every send offers **Slow / Normal / Fast / Custom**. In custom mode, the user enters the following themselves:
- EVM: *max fee per gas* and *priority tip* (gwei);
- Bitcoin: *sat/vB* (and RBF to speed up later);
- Solana: *priority fee* (micro-lamports).

The cost in crypto and in euros, and the estimated delay, are recomputed live; a warning is shown if the fees are below the network minimum.

## Typography

- **Geist** (400, 500, 560): interface. Screen titles at 30 px (−0.038 em), large amounts at 56–76 px in weight 480, tabular figures, decimals in `faint`.
- **Labels** (`.eyebrow`, Geist 12 px, 500, `mute`): section and field labels, table headers, in lowercase like a sentence. No spaced capitals, no decorative mono.
- **Geist Mono** (400, 500): addresses, status bar, times.
- Both fonts (OFL license) will be **embedded in the app**: no call to Google Fonts in production (CSP).

## Shapes

- Only three radii: surfaces 10 px (`rounded-panel`), boxes 7 px (`rounded-box`), controls 6 px (`rounded-ctl`). No pills, except dots and switches.
- Badges as **tags** (thin frame, normal text); only states that call for attention have a color.
- Warnings: left rule in the tone's color (amber, red), never toned down.
- No halo or decorative gradient; a shadow only under dialogs and menus.
- **Nothing decorative "AI-style"**: no slogans, no 01/02/03 numbering on choices, no fake instruments (dials, graduations), no technical mentions as a hook (algorithms, license, "zero telemetry") outside the screens that explain them. Welcome: the logo, the name, three choices.
- Charts: smoothed frost blue curve 1.75 px, frost veil from 16% to 0%, hover dot with ring and tooltip.

## Motion

- Fast (150–350 ms), **on entry only**: nothing delays a click or a navigation.
- Screens: fade + 8 px slide. Lists: staggered entry (`.stagger`, `--i`). Curves: drawn from left to right. Balances: counter (`useTicker`).
- Sliding indicators (`layoutId`): rail, tabs, `Segmented`, Settings sections, Receive network.
- Dialogs and menus: spring entry, short exit. Buttons: slight press.
- `prefers-reduced-motion`: everything is turned off (`MotionConfig reducedMotion="user"` + CSS rule), only the loading wheels spin, slowly.

## Signature components

- **Balance + full-width chart** on the Wallet, outside any card, with Send / Receive / Swap actions.
- **Brand panel** (logo and name, nothing else) on the welcome screen.
- **Address in blocks**: `0x4F2a 9C83 … 6c19 D7b2`, first two and last two blocks on a frost blue background.
- **"In plain words" box**: frost blue label + one sentence.
- **Vault card**: lock state, countdown, hardware wallet, unlimited approvals.
- **Active approvals** in History, with a Revoke button.

## Accessibility

- Clickable targets ≥ 40 px in the content, 44–60 px in the rail.
- Text contrast ≥ 4.5:1 (`mute` on `card` ≈ 6:1).
- Rises and falls always accompanied by an arrow or a sign.
