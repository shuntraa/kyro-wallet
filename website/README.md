# kyrowallet.com

Static site for Kyro Wallet. No framework and no dependencies: Node 22+ only.

| Path | Content |
|---|---|
| `src/build.mjs` | Builds every page into `public/` and checks links, anchors and headings (exits 1 on error) |
| `src/pages.mjs`, `src/layout.mjs` | Page content and shared layout |
| `src/components.mjs` | HTML replicas of the app (window, swap, Earn, confirmation, device). Demo numbers only |
| `src/chains.json` | One entry per blockchain: features (send, swap, staking, hardware), tokens, notes |
| `src/capture.mjs` | Takes fresh app screenshots from the desktop app in demo mode (headless Edge, ffmpeg for WebP) |
| `src/preview.mjs` | Full-page previews of the built site (headless Edge) |
| `src/screenshots/` | App screenshots (WebP; the PNGs from `capture.mjs` are not committed) |
| `icons/` | Coin icons copied into `public/` by the build |
| `public/` | The built site, ready to deploy. Hand-written there: `style.css`, `boot.js`, `motion.js` (inertia, reveals), `silk.js` (WebGL background), `scenes.js` (scroll scenes), `stats.js`, `download.js`, `copy.js` |

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
