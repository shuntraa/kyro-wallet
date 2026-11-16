# kyrowallet.com

Static site for Kyro Wallet. No framework and no dependencies: Node 22+ only.

| Path | Content |
|---|---|
| `src/build.mjs` | Builds every page into `public/` and checks links, anchors and headings (exits 1 on error) |
| `src/pages.mjs`, `src/layout.mjs` | Page content and shared layout |
| `src/components.mjs` | HTML replicas of the app (window, swap, Earn, confirmation, device). Demo numbers only |
| `src/chains.json` | One entry per blockchain: features (send, swap, staking, hardware), tokens, notes |
| `src/light.mjs` | Bakes the two still blue-light images (`img/light-*.webp`). Run by hand, needs ffmpeg |
| `src/capture.mjs` | Takes fresh app screenshots from the desktop app in demo mode (headless Edge, ffmpeg for WebP) |
| `src/preview.mjs` | Full-page previews of the built site (headless Edge) |
| `src/screenshots/` | App screenshots (WebP; the PNGs from `capture.mjs` are not committed) |
| `icons/` | Coin icons copied into `public/` by the build |
| `public/` | The built site, ready to deploy. Hand-written there: `style.css`, `boot.js`, `motion.js` (reveals, header popovers, tabs), `silk.js` (WebGL background, one fixed canvas), `scenes.js` (small time-based scenes), `feecalc.js` (fee slider), `stats.js`, `download.js`, `copy.js` |

## Build

```bash
node website/src/build.mjs
```

After editing `chains.json` or `pages.mjs`, rebuild and commit `public/` with the sources.

## New app screenshots

```bash
cd apps/desktop && node node_modules/vite/bin/vite.js --port 1520 --strictPort --host 127.0.0.1   # demo mode
node website/src/capture.mjs http://127.0.0.1:1520
node website/src/build.mjs
```

`capture.mjs` imports the public BIP39 test phrase in the demo onboarding, then writes `public/img/win-*.webp`. If an image's aspect ratio changes, update `IMG` in `pages.mjs`.

## Deploy (Cloudflare Pages)

Upload the `website/public` folder (direct upload), or connect the repository with:

- Build command: `node website/src/build.mjs`
- Build output directory: `website/public`

`public/_redirects` and `public/_headers` are read by Cloudflare Pages.

## Admin mailer (`/admin/`)

`public/admin/` is a small page to send email from the four kyrowallet.com addresses (contact, support, business, report), through [Resend](https://resend.com). Its server code is in `functions/` (Cloudflare Pages Functions: `/api/admin/login`, `session`, `logout`, `send`). It is published here so anyone can check what it does.

No login, password, hash or key is in this code. Everything comes from Cloudflare Pages secrets, and logins are refused when one is missing or too short:

| Secret | Content |
|---|---|
| `RESEND` | Resend API key |
| `ADMIN_USER` | Login name |
| `ADMIN_PASSWORD` | Password, 16 characters or more |
| `ADMIN_SESSION_SECRET` | Random string, 32 characters or more, used only to sign the session cookie |

Sessions last 12 hours (`HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` cookie). Writes need the site's own origin and a JSON body. The sender is always one of the four addresses in `functions/_lib/config.js`, never a free value. Changing `ADMIN_SESSION_SECRET` logs everyone out.

For the Functions to run, the Pages project needs `functions/` next to its output folder (the deployed site keeps them side by side).
